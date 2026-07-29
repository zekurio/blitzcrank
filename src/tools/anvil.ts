import path from "node:path"

import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { AnvilConfig } from "../config.js"
import { reasonParam, runMutation, textResult } from "./common.js"
import type { RunContext } from "./context.js"
import { ExecError, execFileText } from "./exec.js"

/**
 * Anvil (transcode daemon) correlation tools, ported from the legacy
 * deployment. Read-only; job correlation is exact-absolute-path only — never
 * constructed from titles, release names, or basenames.
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
        "Anvil could not answer this: the path lies outside every configured library root " +
        "and handoff destination, so it can never match a job, whatever is running. This is " +
        "not evidence of absence — check the path against the read it came from.",
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
      "Confirm with anvil_job_list (one call, all current jobs, filter locally) before " +
      "making any statement about whether this item is encoding.",
    checked_path: absolutePath,
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
  "any missing-language question: `missing_languages` names languages the profile requested that the source " +
  "did not have, and each stream carries why it was kept or dropped. A job with no recorded decision has no " +
  "stream_selection field at all, which is not the same as a decision that kept everything."

export function buildAnvilTools(
  cfg: AnvilConfig,
  ctx: RunContext,
): ToolDefinition[] {
  if (!path.isAbsolute(cfg.socket) || cfg.socket.includes("\0")) {
    throw new Error("ANVIL_CONTROL_SOCKET must be an absolute path")
  }

  const anvilctl = (args: string[], signal: AbortSignal | undefined) =>
    execFileText(
      cfg.command,
      ["--socket", cfg.socket, "--timeout", CLIENT_TIMEOUT, "--json", ...args],
      { signal, timeoutMs: EXEC_TIMEOUT_MS },
    ).catch(explainExit)

  /**
   * Job results are recorded as evidence so the converted-file path they carry
   * can be probed: anvil's output is the only place that path appears, and
   * comparing it against the source is what settles "was the track lost during
   * conversion?". Evidence is service-scoped, so this can never satisfy a
   * Sonarr/Radarr id gate. Daemon health carries no paths and is not recorded.
   */
  const recordJobs = (query: string, response: Record<string, unknown>) => {
    ctx.recordRead("anvil", query, JSON.stringify(response))
    return response
  }

  return [
    defineTool({
      name: "anvil_status",
      label: "Anvil daemon status",
      description:
        "Read factual Anvil daemon health and aggregate queue counts. This never proves that a specific media item is being encoded. " +
        "blitzcrank's Anvil tools are read-only: it has no way to cancel, pause, reprioritise, or retry an encode.",
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
        "List all current Anvil jobs in one call, then filter them locally. Prefer this over repeated anvil_job_lookup calls: " +
        "it cannot produce the false negative a wrong path produces, and it is the only way to establish that an item has no job. " +
        "Read-only: blitzcrank cannot cancel, pause, or retry an encode.",
      parameters: Type.Object({
        purpose: Type.String({
          description: "What this list of current Anvil jobs must establish",
        }),
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
        const selection = params.includeStreamSelection === true
        const stdout = await anvilctl(
          [
            "job",
            "list",
            "--current-only",
            "--limit",
            limit,
            ...(selection ? ["--with-selection"] : []),
          ],
          signal,
        )
        return textResult(
          recordJobs(
            `job list --current-only --limit ${limit}${selection ? " --with-selection" : ""}`,
            parseAnvilResponse(stdout),
          ),
          { action: "anvil_job_list" },
        )
      },
    }),
    defineTool({
      name: "anvil_job_show",
      label: "Show one Anvil job",
      description:
        "Read the full recorded history of one Anvil job by id or slug: state, attempts with their errors, publish " +
        "operation, and the audio/subtitle stream decisions. Use it after a lookup or listing has identified the job " +
        "— this is where a failed or stuck encode explains itself. The reference must come from an Anvil read this run.",
      parameters: Type.Object({
        purpose: Type.String({
          description: "What this job's history must establish",
        }),
        job: Type.String({
          minLength: 1,
          description:
            "Anvil job id or slug, exactly as an earlier Anvil read reported it",
        }),
      }),
      async execute(_toolCallId, params, signal) {
        const job = params.job.trim()
        ctx.requireEvidence("anvil", job, "job id or slug")
        const stdout = await anvilctl(["job", "show", job], signal)
        return textResult(
          recordJobs(`job show ${job}`, parseAnvilResponse(stdout)),
          { action: "anvil_job_show", job },
        )
      },
    }),
    defineTool({
      name: "anvil_retry_job",
      label: "Anvil: requeue a job",
      description:
        "Requeue one Anvil job that will not finish on its own — a failed encode blocking an import, or a job canceled " +
        "earlier. It re-runs the conversion from the start; it cannot recover the work already discarded. The job id or " +
        "slug must come from an Anvil read this run. Only single jobs: there is no bulk retry here.",
      parameters: Type.Object({
        reason: reasonParam(),
        job: Type.String({
          minLength: 1,
          description:
            "Anvil job id or slug, exactly as an earlier Anvil read reported it",
        }),
      }),
      async execute(_toolCallId, params, signal) {
        const job = params.job.trim()
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service: "anvil", value: job, hint: "job id or slug" }],
          perform: async () =>
            parseAnvilResponse(await anvilctl(["job", "retry", job], signal)),
          verify: async () =>
            recordJobs(
              `job show ${job}`,
              parseAnvilResponse(await anvilctl(["job", "show", job], signal)),
            ),
        })
        return textResult(outcome, { action: "anvil_retry_job", job })
      },
    }),
    defineTool({
      name: "anvil_job_lookup",
      label: "Find exact Anvil jobs",
      description:
        "Correlate one exact absolute path to current Anvil jobs. Matches a job's source, asset or destination and reports which " +
        "side hit in `matched_on`, so the encoder's input and its converted output both resolve. No fuzzy, basename, title, or " +
        "substring matching. An empty result means UNKNOWN, never 'no job exists' — use anvil_job_list to establish absence.",
      parameters: Type.Object({
        purpose: Type.String({
          description: "Why this exact Anvil job correlation is needed",
        }),
        absolute_path: Type.String({
          description:
            "Exact absolute path from a service read (Sonarr/Radarr outputPath or file path, SABnzbd storage, or a converted path from an earlier job result); never a title, basename, or guessed path",
        }),
        includeStreamSelection: Type.Optional(
          Type.Boolean({
            description: SELECTION_PARAM,
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const target = params.absolute_path.trim()
        if (!path.isAbsolute(target) || target.includes("\0")) {
          throw new Error("absolute_path must be an exact absolute path")
        }
        const selection = params.includeStreamSelection === true
        const stdout = await anvilctl(
          [
            "job",
            "list",
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
              `job list --absolute-path ${target} --current-only${selection ? " --with-selection" : ""}`,
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
