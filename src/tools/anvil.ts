import path from "node:path"

import { StringEnum } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { AnvilConfig } from "../config.js"
import {
  MAX_RESULT_CHARS,
  reasonParam,
  runMutation,
  textResult,
} from "./common.js"
import type { RunContext } from "./context.js"
import { ExecError, execFileText } from "./exec.js"

/**
 * Anvil (transcode daemon) correlation tools, ported from the legacy
 * deployment. Reads plus one evidence-gated retry are exposed; job correlation
 * is exact-absolute-path only — never constructed from titles, release names,
 * or basenames.
 *
 * An empty result is labelled "unknown" rather than "none": the legacy rule
 * ("zero matches mean the item is not an Anvil wait") turned a silent miss into
 * a confident public claim while eighteen jobs were running. Anvil matches
 * source, asset and destination paths and reports which side hit (`matched_on`),
 * so a miss is genuinely a miss — but only of that exact path, at that moment.
 */

/** anvilctl's own deadline, kept under the exec timeout that kills it. */
const CLIENT_TIMEOUT = "15s"
const EXEC_TIMEOUT_MS = 20_000
/** A 64 MiB Anvil frame can grow when anvilctl pretty-prints its JSON. */
const ANVIL_MAX_BUFFER_BYTES = 128 * 1024 * 1024
const DIAGNOSTIC_EVENT_CHARS = 10_000
const FALLBACK_ATTEMPT_LIMIT = 20
const PAYLOAD_SAMPLE_CHARS = 1_000
const PUBLISH_MANIFEST_LIMIT = 20

const JOB_STATES = [
  "pending",
  "leased",
  "running",
  "validating",
  "replacing",
  "complete",
  "failed",
  "retrying",
  "skipped",
  "canceled",
] as const

/**
 * anvilctl's exit codes are part of its contract, and the difference between
 * them is the difference between "no encode for this file" and "blitzcrank
 * could not ask". Collapsing them would rebuild the false negative this whole
 * tool set exists to prevent, one layer lower.
 */
function explainExit(error: unknown): never {
  if (!(error instanceof ExecError)) throw error
  if (error.exitCode === 3) {
    throw new Error(
      `Anvil is unreachable or speaks a different protocol (${error.message}). ` +
        "This says nothing about whether anything is encoding: report the control plane " +
        "as unavailable, never as 'no conversion job exists'.",
    )
  }
  if (error.exitCode === 4) {
    throw new Error(
      `Anvil has no such job, library, or path (${error.message}). Re-read the job list ` +
        "rather than guessing another reference.",
    )
  }
  throw error
}

function parseAnvilResponse(stdout: string): Record<string, unknown> {
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new Error("anvilctl returned invalid JSON")
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("anvilctl returned an invalid response object")
  }
  const response = payload as Record<string, unknown>
  if (response.api_version !== "v1") {
    throw new Error(
      `unsupported Anvil API version ${JSON.stringify(response.api_version)}`,
    )
  }
  return response
}

/**
 * The jobs array, when the response shape makes it unambiguous. Returning
 * undefined means "cannot tell" and is never treated as an empty result.
 */
function jobsOf(response: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(response.jobs)) return response.jobs
  const data = response.data
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { jobs?: unknown }).jobs)
  ) {
    return (data as { jobs: unknown[] }).jobs
  }
  return undefined
}

interface AnvilJobIdentity {
  id: string
  slug: string | undefined
}

/** Extract only the paired id/slug fields declared by Anvil's job schema. */
function jobIdentitiesOf(
  response: Record<string, unknown>,
): AnvilJobIdentity[] {
  const candidates = [...(jobsOf(response) ?? [])]
  if (response.job !== undefined) candidates.push(response.job)
  const identities = new Map<string, AnvilJobIdentity>()
  for (const candidate of candidates) {
    const job = recordOf(candidate)
    if (!job) continue
    const id = String(job.id)
    if (!/^\d+$/.test(id)) continue
    identities.set(id, {
      id,
      slug:
        typeof job.slug === "string" && job.slug !== "" ? job.slug : undefined,
    })
  }
  return [...identities.values()]
}

/** Extract only absolute paths from Anvil's declared job/publication fields. */
function recordAnvilPaths(
  ctx: RunContext,
  response: Record<string, unknown>,
): void {
  for (const candidate of jobsOf(response) ?? []) {
    const job = recordOf(candidate)
    if (!job) continue
    for (const occurrence of [job.source, job.asset]) {
      const absolutePath = recordOf(occurrence)?.absolute_path
      if (typeof absolutePath === "string" && path.isAbsolute(absolutePath)) {
        ctx.recordPath("anvil", absolutePath)
      }
    }
    if (
      typeof job.destination_path === "string" &&
      path.isAbsolute(job.destination_path)
    ) {
      ctx.recordPath("anvil", job.destination_path)
    }
  }

  const operation = recordOf(response.publish_operation)
  if (!operation) return
  for (const field of [
    "artifact_path",
    "backup_path",
    "cleanup_source_path",
    "destination_path",
  ] as const) {
    const value = operation[field]
    if (typeof value === "string" && path.isAbsolute(value)) {
      ctx.recordPath("anvil", value)
    }
  }
  for (const entry of Array.isArray(operation.cleanup_entries)
    ? operation.cleanup_entries
    : []) {
    const value = recordOf(entry)?.path
    if (typeof value === "string" && path.isAbsolute(value)) {
      ctx.recordPath("anvil", value)
    }
  }
  for (const value of Array.isArray(operation.cleanup_directories)
    ? operation.cleanup_directories
    : []) {
    if (typeof value === "string" && path.isAbsolute(value)) {
      ctx.recordPath("anvil", value)
    }
  }
}

/**
 * Wraps a lookup response so a miss can never be read as proof of absence:
 * the model sees an explicit "unknown" conclusion plus the reasons a
 * correct-looking lookup still misses.
 */
export function interpretJobLookup(
  response: Record<string, unknown>,
  absolutePath: string,
): Record<string, unknown> {
  const jobs = jobsOf(response)
  if (jobs && jobs.length > 0) return response
  // Anvil says so itself when the path resolved under no configured library
  // root or handoff destination: the question was unanswerable, not answered.
  if (response.path_outside_libraries === true) {
    return {
      ...response,
      matched: "unanswerable",
      conclusion:
        "Anvil could not answer this under its current library roots and handoff destinations. " +
        "A historical job from a reconfigured library may still own the path. This is not " +
        "evidence of absence — check the path against the read it came from.",
      checked_path: absolutePath,
    }
  }
  return {
    ...response,
    matched: jobs ? 0 : "unknown",
    conclusion:
      "UNKNOWN, not absence. Zero matches only mean no job is indexed under this exact " +
      "path right now: the item may not be queued yet, the source may have a newer " +
      'generation, or the job may have been pruned. Do not report "no conversion job ' +
      'exists" from this result.',
    next_step:
      "Confirm with a non-truncated anvil_job_list result, narrowed by state when needed, " +
      "before making any statement about whether this item is encoding.",
    checked_path: absolutePath,
  }
}

/** Makes both Anvil's result cap and pi's text cap impossible to overlook. */
function interpretJobList(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const renderedChars = JSON.stringify(response, null, 2).length
  if (response.truncated !== true && renderedChars <= MAX_RESULT_CHARS) {
    return response
  }
  return {
    output_complete: false,
    conclusion:
      "INCOMPLETE LIST. This result cannot establish that a job is absent.",
    next_step:
      "Narrow another anvil_job_list call with states and/or a smaller limit. Never decide " +
      "from a result with truncated: true or a blitzcrank output truncation marker.",
    ...response,
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function diagnosticEvent(value: unknown): boolean {
  const event = recordOf(value)
  if (!event) return false
  if (event.type === "block_failed") return true
  if (event.name === "failed-staging-cleanup") return true
  if (
    typeof event.payload_error === "string" &&
    event.payload_error.trim() !== ""
  ) {
    return true
  }
  const processOutput = recordOf(event.process_output)
  if (!processOutput) return false
  if (
    typeof processOutput.exit_code === "number" &&
    processOutput.exit_code !== 0
  ) {
    return true
  }
  return (
    typeof processOutput.error === "string" && processOutput.error.trim() !== ""
  )
}

function compactPayload(value: unknown): Record<string, unknown> | undefined {
  const payload = recordOf(value)
  if (!payload) return undefined
  const compact: Record<string, unknown> = {
    kind: payload.kind,
    size_bytes: payload.size_bytes,
  }
  for (const field of ["json", "text", "bytes_base64"] as const) {
    if (payload[field] === undefined) continue
    const rendered =
      typeof payload[field] === "string"
        ? payload[field]
        : JSON.stringify(payload[field])
    if (rendered === undefined) continue
    compact[`${field}_sample`] = rendered.slice(0, PAYLOAD_SAMPLE_CHARS)
    if (rendered.length > PAYLOAD_SAMPLE_CHARS) {
      compact[`${field}_omitted_chars`] = rendered.length - PAYLOAD_SAMPLE_CHARS
    }
  }
  return compact
}

function compactEvent(
  value: unknown,
  attempt: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const event = recordOf(value)
  if (!event) return undefined
  const compact = { ...event }
  if (
    typeof event.payload_error === "string" &&
    event.payload_error.trim() !== ""
  ) {
    compact.payload = compactPayload(event.payload)
  } else {
    delete compact.payload
  }
  delete compact.stream_selection
  return {
    ...compact,
    attempt_id: attempt.id,
    attempt_number: attempt.number,
  }
}

function compactPipelineContext(value: unknown): unknown {
  const context = recordOf(value)
  if (!context) return value
  if (
    context.search_metric !== "xpsnr" ||
    context.search_xpsnr !== undefined ||
    context.search_skip_reason !== undefined ||
    typeof context.search_crf !== "number" ||
    context.search_crf <= 0
  ) {
    return context
  }
  return {
    ...context,
    search_xpsnr: 0,
    search_xpsnr_inferred_from_omitempty: true,
  }
}

function compactPublishOperation(value: unknown): unknown {
  const operation = recordOf(value)
  if (!operation) return value
  const compact = { ...operation }
  const entries = Array.isArray(operation.cleanup_entries)
    ? operation.cleanup_entries
    : []
  if (entries.length > PUBLISH_MANIFEST_LIMIT) {
    compact.cleanup_entries = entries.slice(0, PUBLISH_MANIFEST_LIMIT)
    compact.cleanup_entries_total = entries.length
    compact.cleanup_entries_omitted = entries.length - PUBLISH_MANIFEST_LIMIT
    compact.cleanup_entries_size_bytes = entries.reduce((total, entry) => {
      const size = recordOf(entry)?.size_bytes
      return total + (typeof size === "number" ? size : 0)
    }, 0)
  }
  const directories = Array.isArray(operation.cleanup_directories)
    ? operation.cleanup_directories
    : []
  if (directories.length > PUBLISH_MANIFEST_LIMIT) {
    compact.cleanup_directories = directories.slice(0, PUBLISH_MANIFEST_LIMIT)
    compact.cleanup_directories_total = directories.length
    compact.cleanup_directories_omitted =
      directories.length - PUBLISH_MANIFEST_LIMIT
  }
  return compact
}

/**
 * `show` includes every event and may legally be 64 MiB. Keep every attempt's
 * state/error first, then fit failure diagnostics into their own byte budget so
 * routine event payloads can never hide the retry evidence behind pi's cap.
 */
function compactJobShow(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const attempts = Array.isArray(response.attempts) ? response.attempts : []
  const summaries: unknown[] = []
  const diagnostics: Record<string, unknown>[] = []

  for (const value of attempts) {
    const attempt = recordOf(value)
    if (!attempt) {
      summaries.push(value)
      continue
    }
    const events = Array.isArray(attempt.events) ? attempt.events : []
    const summary = { ...attempt }
    delete summary.events
    summary.event_count = events.length
    summaries.push(summary)
    for (const event of events.filter(diagnosticEvent)) {
      const compact = compactEvent(event, attempt)
      if (compact) diagnostics.push(compact)
    }
  }

  const diagnosticEvents: Record<string, unknown>[] = []
  let diagnosticChars = 0
  for (const diagnostic of diagnostics.toReversed()) {
    const chars = JSON.stringify(diagnostic).length
    if (diagnosticChars + chars > DIAGNOSTIC_EVENT_CHARS) break
    diagnosticEvents.unshift(diagnostic)
    diagnosticChars += chars
  }

  const compact = {
    api_version: response.api_version,
    server_time: response.server_time,
    job: response.job,
    attempts: summaries,
    pipeline_context: compactPipelineContext(response.pipeline_context),
    publish_operation: compactPublishOperation(response.publish_operation),
    stream_selection: response.stream_selection,
    history_compacted: true,
    history_note:
      "Routine event payloads were omitted. Every attempt state/error is present; " +
      "diagnostic_events contains failed blocks, failed staging cleanup, and process/payload errors.",
    diagnostic_event_count: diagnostics.length,
    diagnostic_events: diagnosticEvents,
    ...(diagnostics.length > diagnosticEvents.length
      ? {
          diagnostic_events_omitted:
            diagnostics.length - diagnosticEvents.length,
        }
      : {}),
  }
  if (JSON.stringify(compact, null, 2).length <= MAX_RESULT_CHARS) {
    return compact
  }

  const recentAttempts = summaries
    .slice(-FALLBACK_ATTEMPT_LIMIT)
    .map(compactFallbackAttempt)
  const operation = recordOf(response.publish_operation)
  return {
    api_version: response.api_version,
    server_time: response.server_time,
    output_complete: false,
    conclusion:
      "INCOMPLETE JOB HISTORY. Do not retry this job: the complete attempt diagnostics did not fit in one tool result.",
    job: response.job,
    attempt_count: summaries.length,
    attempts_returned: recentAttempts.length,
    attempts_omitted: summaries.length - recentAttempts.length,
    attempts: recentAttempts,
    pipeline_context_present: response.pipeline_context !== undefined,
    publish_operation:
      operation === undefined
        ? undefined
        : {
            kind: operation.kind,
            mode: operation.mode,
            stage: operation.stage,
            destination_path: operation.destination_path,
            backup_path: operation.backup_path,
            conflict_description: operation.conflict_description,
            cleanup_entries_count: Array.isArray(operation.cleanup_entries)
              ? operation.cleanup_entries.length
              : 0,
            cleanup_directories_count: Array.isArray(
              operation.cleanup_directories,
            )
              ? operation.cleanup_directories.length
              : 0,
          },
    stream_selection_count: Array.isArray(response.stream_selection)
      ? response.stream_selection.length
      : 0,
    diagnostic_event_count: diagnostics.length,
  }
}

function compactFallbackAttempt(value: unknown): unknown {
  const attempt = recordOf(value)
  if (!attempt) return value
  const error =
    typeof attempt.error === "string"
      ? attempt.error.slice(0, PAYLOAD_SAMPLE_CHARS)
      : attempt.error
  return {
    id: attempt.id,
    number: attempt.number,
    state: attempt.state,
    worker_id: attempt.worker_id,
    started_at: attempt.started_at,
    finished_at: attempt.finished_at,
    error,
    ...(typeof attempt.error === "string" &&
    attempt.error.length > PAYLOAD_SAMPLE_CHARS
      ? { error_omitted_chars: attempt.error.length - PAYLOAD_SAMPLE_CHARS }
      : {}),
    event_count: attempt.event_count,
  }
}

/**
 * Anvil records which streams it kept and dropped, and why, on the attempt — so
 * it answers a language question even after the source file is gone, and it
 * separates "the profile never asked for that language" from "the profile asked
 * and the source had none". No probe of the output file can tell those apart.
 */
const SELECTION_PARAM =
  "Include the audio/subtitle streams Anvil kept and dropped on its latest recorded attempt. Set this for " +
  "any missing-language question: a normal language-filter decision uses `missing_languages` for requested " +
  "languages absent from the source, and each stream says why it was kept or dropped. `cleanup_disabled` may " +
  "omit that computation. A job with no recorded decision has no `stream_selection` field at all, which is not " +
  "the same as a decision that kept everything."

export function buildAnvilTools(
  cfg: AnvilConfig,
  ctx: RunContext,
): ToolDefinition[] {
  if (!path.isAbsolute(cfg.socket) || cfg.socket.includes("\0")) {
    throw new Error("ANVIL_CONTROL_SOCKET must be an absolute path")
  }

  // Numeric IDs are never reused and may survive issue resumption. Slugs have
  // a finite namespace and may be reused after pruning, so they are current-run
  // aliases only and are always canonicalized back to their paired numeric ID.
  const jobSlugs = new Map<string, string>()

  const anvilctl = (args: string[], signal: AbortSignal | undefined) =>
    execFileText(
      cfg.command,
      ["--socket", cfg.socket, "--timeout", CLIENT_TIMEOUT, "--json", ...args],
      {
        signal,
        timeoutMs: EXEC_TIMEOUT_MS,
        maxBufferBytes: ANVIL_MAX_BUFFER_BYTES,
      },
    ).catch(explainExit)

  /**
   * `jobs` and `retry` were aliases before Anvil flattened its CLI, but `show`
   * has no spelling shared by both versions. Only the old client's exact
   * unknown-command usage error activates this fallback, so daemon argument
   * errors are never mistaken for a dialect change.
   */
  const showJob = async (
    job: string,
    signal: AbortSignal | undefined,
  ): Promise<{ stdout: string; query: string }> => {
    try {
      return {
        stdout: await anvilctl(["show", job], signal),
        query: `show ${job}`,
      }
    } catch (error) {
      if (
        !(error instanceof ExecError) ||
        error.exitCode !== 2 ||
        !error.message.includes('unknown command "show"')
      ) {
        throw error
      }
    }
    return {
      stdout: await anvilctl(["job", "show", job], signal),
      query: `job show ${job} (legacy fallback)`,
    }
  }

  /**
   * Job results are recorded as evidence so the converted-file path they carry
   * can be probed: anvil's output is the only place that path appears, and
   * comparing it against the source is what settles "was the track lost during
   * conversion?". Evidence is service-scoped, so this can never satisfy a
   * Sonarr/Radarr id gate. Daemon health carries no paths and is not recorded.
   */
  const recordJobs = (query: string, response: Record<string, unknown>) => {
    ctx.recordRead("anvil", query, JSON.stringify(response))
    recordAnvilPaths(ctx, response)
    for (const identity of jobIdentitiesOf(response)) {
      ctx.recordIdentity("anvil", identity.id)
      if (identity.slug !== undefined) {
        const existing = jobSlugs.get(identity.slug)
        if (existing !== undefined && existing !== identity.id) {
          throw new Error(
            `anvilctl returned slug ${identity.slug} for both job ${existing} and ${identity.id}`,
          )
        }
        jobSlugs.set(identity.slug, identity.id)
      }
    }
    return response
  }

  const resolveJobReference = (reference: string): string => {
    if (/^\d+$/.test(reference)) {
      ctx.requireIdentity("anvil", reference, "job id")
      return reference
    }
    const id = jobSlugs.get(reference)
    if (id !== undefined) return id
    throw new Error(
      `evidence gate: Anvil job slug ${reference} was not returned this run. ` +
        "Re-read the job list; slugs are not carried across runs because Anvil may reuse them after pruning.",
    )
  }

  return [
    defineTool({
      name: "anvil_status",
      label: "Anvil daemon status",
      description:
        "Read factual Anvil daemon health and aggregate queue counts. This never proves that a specific media item is being encoded, " +
        "and its queue counts never establish item-level waiting.",
      parameters: Type.Object({
        purpose: Type.String({
          description: "Why Anvil daemon health is needed for this diagnosis",
        }),
      }),
      async execute(_toolCallId, _params, signal) {
        const stdout = await anvilctl(["status"], signal)
        return textResult(parseAnvilResponse(stdout), {
          action: "anvil_status",
        })
      },
    }),
    defineTool({
      name: "anvil_job_list",
      label: "List current Anvil jobs",
      description:
        "List a bounded view of current Anvil jobs and filter it locally. Narrow by state when possible. " +
        "This avoids a wrong-path false negative only when both Anvil and blitzcrank report the output as complete; " +
        "never establish absence from `truncated: true`, `output_complete: false`, or a local truncation marker. Read-only.",
      parameters: Type.Object({
        purpose: Type.String({
          description: "What this list of current Anvil jobs must establish",
        }),
        states: Type.Optional(
          Type.Array(StringEnum(JOB_STATES), {
            minItems: 1,
            uniqueItems: true,
            description:
              "Optional job states to include. Narrow to relevant states so a complete result fits in one response.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 500,
            description: "Max jobs to return (default 200)",
          }),
        ),
        includeStreamSelection: Type.Optional(
          Type.Boolean({
            description: SELECTION_PARAM,
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const limit = String(params.limit ?? 200)
        const states = params.states?.join(",")
        const selection = params.includeStreamSelection === true
        const query =
          `jobs --current-only --limit ${limit}` +
          `${states ? ` --state ${states}` : ""}` +
          `${selection ? " --with-selection" : ""}`
        const response = recordJobs(
          query,
          parseAnvilResponse(
            await anvilctl(
              [
                "jobs",
                "--current-only",
                "--limit",
                limit,
                ...(states ? ["--state", states] : []),
                ...(selection ? ["--with-selection"] : []),
              ],
              signal,
            ),
          ),
        )
        return textResult(interpretJobList(response), {
          action: "anvil_job_list",
        })
      },
    }),
    defineTool({
      name: "anvil_job_show",
      label: "Show one Anvil job",
      description:
        "Read a compact diagnostic history of one Anvil job by id or slug: current state and, when output is complete, every attempt state/error, " +
        "failed events, resumable pipeline checkpoints, publish/cleanup operation, quality-search metric, and stream decisions. " +
        "Routine event payloads are omitted so errors stay visible; `output_complete: false` means operator review and blocks retry. " +
        "A numeric id may come from this issue's carried evidence; a slug must come from an Anvil read this run.",
      parameters: Type.Object({
        purpose: Type.String({
          description: "What this job's history must establish",
        }),
        job: Type.String({
          minLength: 1,
          description:
            "Anvil numeric job id from this issue, or slug exactly as an Anvil read reported it in this run",
        }),
      }),
      async execute(_toolCallId, params, signal) {
        const reference = params.job.trim()
        const job = resolveJobReference(reference)
        const shown = await showJob(job, signal)
        return textResult(
          compactJobShow(
            recordJobs(shown.query, parseAnvilResponse(shown.stdout)),
          ),
          { action: "anvil_job_show", job, reference },
        )
      },
    }),
    defineTool({
      name: "anvil_retry_job",
      label: "Anvil: requeue a job",
      description:
        "Requeue one failed Anvil job that will not finish on its own, normally an encode blocking an import. " +
        "The interrupted encode restarts, while reusable analysis checkpoints and a journaled publish may resume. " +
        "Canceled, active, complete, and skipped jobs are rejected. A numeric id may come from this issue's carried evidence; " +
        "a slug must come from an Anvil read this run. Only single jobs: there is no bulk retry here.",
      parameters: Type.Object({
        reason: reasonParam(),
        job: Type.String({
          minLength: 1,
          description:
            "Anvil numeric job id from this issue, or slug exactly as an Anvil read reported it in this run",
        }),
      }),
      async execute(_toolCallId, params, signal) {
        const reference = params.job.trim()
        const job = resolveJobReference(reference)
        const beforeShown = await showJob(job, signal)
        const before = recordJobs(
          beforeShown.query,
          parseAnvilResponse(beforeShown.stdout),
        )
        const beforeDiagnostic = compactJobShow(before)
        if (beforeDiagnostic.output_complete === false) {
          throw new Error(
            `Anvil job ${job} has an incomplete diagnostic history. ` +
              "Refusing retry because prior attempt failures could be hidden; require operator review.",
          )
        }
        const state = recordOf(before.job)?.state
        if (state !== "failed") {
          throw new Error(
            `Anvil job ${job} is ${JSON.stringify(state)}, not failed. ` +
              "blitzcrank retries only diagnosed failures. Do not retry canceled, active, complete, or skipped work; use operator review where the state remains unhealthy or ambiguous.",
          )
        }
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [
            {
              service: "anvil",
              value: job,
              hint: "job id or slug",
              identity: true,
            },
          ],
          perform: async () =>
            parseAnvilResponse(await anvilctl(["retry", job], signal)),
          verify: async () => {
            const shown = await showJob(job, signal)
            return compactJobShow(
              recordJobs(shown.query, parseAnvilResponse(shown.stdout)),
            )
          },
        })
        return textResult(outcome, {
          action: "anvil_retry_job",
          job,
          reference,
        })
      },
    }),
    defineTool({
      name: "anvil_job_lookup",
      label: "Find exact Anvil jobs",
      description:
        "Correlate one exact absolute path to current Anvil jobs. Matches a job's source, asset, destination, or destination " +
        "directory and reports which side hit in `matched_on`, so the encoder's input and converted output both resolve. " +
        "No fuzzy, basename, title, or " +
        "substring matching. An empty result means UNKNOWN, never 'no job exists' — use a complete anvil_job_list snapshot " +
        "to establish only whether a matching job is active at that moment.",
      parameters: Type.Object({
        purpose: Type.String({
          description: "Why this exact Anvil job correlation is needed",
        }),
        absolute_path: Type.String({
          description:
            "Exact absolute path from a read this run (Sonarr/Radarr outputPath or file path, SABnzbd storage, or a converted path from an earlier job result); never a title, basename, or guessed path",
        }),
        includeStreamSelection: Type.Optional(
          Type.Boolean({
            description: SELECTION_PARAM,
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const target = params.absolute_path
        if (!path.isAbsolute(target) || target.includes("\0")) {
          throw new Error("absolute_path must be an exact absolute path")
        }
        if (!ctx.sawRecordedPath(target)) {
          throw new Error(
            `evidence gate: ${target} was not returned in a service or Anvil path field this run. ` +
              "Look up only an exact path returned by Arr, SABnzbd, Jellyfin, or an earlier Anvil result; " +
              "never use issue text or reconstruct a path.",
          )
        }
        const selection = params.includeStreamSelection === true
        const stdout = await anvilctl(
          [
            "jobs",
            "--absolute-path",
            target,
            "--current-only",
            ...(selection ? ["--with-selection"] : []),
          ],
          signal,
        )
        return textResult(
          interpretJobLookup(
            recordJobs(
              `jobs --absolute-path ${target} --current-only${selection ? " --with-selection" : ""}`,
              parseAnvilResponse(stdout),
            ),
            target,
          ),
          { action: "anvil_job_lookup" },
        )
      },
    }),
  ]
}
