import path from "node:path"

import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { AnvilConfig } from "../config.js"
import { textResult } from "./common.js"
import type { RunContext } from "./context.js"
import { execFileText } from "./exec.js"

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
    execFileText(cfg.command, ["--socket", cfg.socket, ...args], { signal })

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
        const stdout = await anvilctl(["status", "--json"], signal)
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
            "--json",
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
            "--json",
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
