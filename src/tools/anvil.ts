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
 * Anvil indexes jobs by *source* path. A lookup against a converted/destination
 * path, or against an item that simply has no job queued yet, returns zero rows
 * with no error — and the legacy rule ("zero matches mean the item is not an
 * Anvil wait") turned that silent miss into a confident public claim. Both are
 * handled here in code: destination paths are rejected when the operator
 * configures the output roots, and an empty result is labelled "unknown"
 * instead of "none".
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

/** Rejects Anvil *output* paths, which always match zero jobs. */
export function assertAnvilSourcePath(
  absolutePath: string,
  destinationRoots: string[],
): void {
  const hit = destinationRoots.find(
    (root) => absolutePath === root || absolutePath.startsWith(root + path.sep),
  )
  if (!hit) return
  throw new Error(
    `${absolutePath} is under the Anvil output root ${hit}: Anvil indexes jobs by their ` +
      "source path (the SABnzbd storage or Arr outputPath the encoder reads), so this " +
      "lookup would return zero jobs whether or not one exists. Look up the source path, " +
      "or list current jobs with anvil_job_list.",
  )
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
 * the model sees an explicit "unknown" conclusion plus the two reasons a
 * correct-looking lookup misses.
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
      "source path: the path may be an Anvil output/destination path, a different " +
      "generation of the source, or the item may not be queued yet. Do not report " +
      '"no conversion job exists" from this result.',
    next_step:
      "Confirm with anvil_job_list (one call, all current jobs, filter locally) before " +
      "making any statement about whether this item is encoding.",
    checked_source_path: absolutePath,
  }
}

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
      }),
      async execute(_toolCallId, params, signal) {
        const stdout = await anvilctl(
          [
            "job",
            "list",
            "--current-only",
            "--limit",
            String(params.limit ?? 200),
            "--json",
          ],
          signal,
        )
        return textResult(
          recordJobs(
            `job list --current-only --limit ${params.limit ?? 200}`,
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
        "Correlate one exact absolute *source* path (Sonarr/Radarr outputPath or SABnzbd storage) to current Anvil jobs. " +
        "No fuzzy, basename, title, or substring matching is performed. Anvil indexes by source path, so a converted/output " +
        "path matches nothing; an empty result means UNKNOWN, never 'no job exists' — use anvil_job_list to establish absence.",
      parameters: Type.Object({
        purpose: Type.String({
          description: "Why this exact Anvil job correlation is needed",
        }),
        absolute_path: Type.String({
          description:
            "Exact absolute Sonarr/Radarr outputPath or SABnzbd storage path that Anvil reads as its source; never a converted/output path, title, basename, or guessed path",
        }),
      }),
      async execute(_toolCallId, params, signal) {
        const target = params.absolute_path.trim()
        if (!path.isAbsolute(target) || target.includes("\0")) {
          throw new Error("absolute_path must be an exact absolute path")
        }
        assertAnvilSourcePath(target, cfg.destinationRoots)
        const stdout = await anvilctl(
          [
            "job",
            "list",
            "--absolute-path",
            target,
            "--current-only",
            "--json",
          ],
          signal,
        )
        return textResult(
          interpretJobLookup(
            recordJobs(
              `job list --absolute-path ${target} --current-only`,
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
