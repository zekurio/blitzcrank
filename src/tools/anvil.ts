import { isAbsolute } from "node:path"

import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { AnvilConfig } from "../config.js"
import { textResult } from "./common.js"
import { execFileText } from "./exec.js"

/**
 * Anvil (transcode daemon) correlation tools, ported from the legacy
 * deployment. Read-only; job correlation is exact-absolute-path only — never
 * constructed from titles, release names, or basenames.
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

export function buildAnvilTools(cfg: AnvilConfig): ToolDefinition[] {
  if (!isAbsolute(cfg.socket) || cfg.socket.includes("\0")) {
    throw new Error("ANVIL_CONTROL_SOCKET must be an absolute path")
  }

  return [
    defineTool({
      name: "anvil_status",
      label: "Anvil daemon status",
      description:
        "Read factual Anvil daemon health and aggregate queue counts. This never proves that a specific media item is being encoded.",
      parameters: Type.Object({
        purpose: Type.String({
          description: "Why Anvil daemon health is needed for this diagnosis",
        }),
      }),
      async execute(_toolCallId, _params, signal) {
        const stdout = await execFileText(
          cfg.command,
          ["--socket", cfg.socket, "status", "--json"],
          { signal },
        )
        return textResult(parseAnvilResponse(stdout), {
          action: "anvil_status",
        })
      },
    }),
    defineTool({
      name: "anvil_job_lookup",
      label: "Find exact Anvil jobs",
      description:
        "Correlate one exact absolute Sonarr/Radarr outputPath or SABnzbd storage path to current Anvil jobs. No fuzzy, basename, title, or substring matching is performed.",
      parameters: Type.Object({
        purpose: Type.String({
          description: "Why this exact Anvil job correlation is needed",
        }),
        absolute_path: Type.String({
          description:
            "Exact absolute Sonarr/Radarr outputPath or SABnzbd storage path; never a title, basename, or guessed path",
        }),
      }),
      async execute(_toolCallId, params, signal) {
        const path = params.absolute_path.trim()
        if (!isAbsolute(path) || path.includes("\0")) {
          throw new Error("absolute_path must be an exact absolute path")
        }
        const stdout = await execFileText(
          cfg.command,
          [
            "--socket",
            cfg.socket,
            "job",
            "list",
            "--absolute-path",
            path,
            "--current-only",
            "--json",
          ],
          { signal },
        )
        return textResult(parseAnvilResponse(stdout), {
          action: "anvil_job_lookup",
        })
      },
    }),
  ]
}
