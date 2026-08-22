import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { SeerrClient } from "../services/seerr.ts"
import { textResult } from "./common.ts"

/** The run's single live status comment on the issue. */
export interface StatusComment {
  id: number | undefined
}

/** Max report_progress calls per run; keeps status churn bounded. */
const MAX_PROGRESS_UPDATES = 4

export function buildProgressTool(
  seerr: SeerrClient,
  issueId: string | number,
  anchor: string,
  language: string,
  status: StatusComment,
): ToolDefinition {
  let calls = 0
  return defineTool({
    name: "report_progress",
    label: "Report issue progress",
    description:
      `Publish or rewrite this run's single live status line: one short user-facing ${language} sentence ` +
      "describing what you are doing right now. Call it as your first action, then again only when the work " +
      `moves to a clearly different phase (max ${MAX_PROGRESS_UPDATES} calls). Each call replaces the previous ` +
      "text instead of adding a comment, and your final response replaces it again. Shown publicly: no internal " +
      "tool names, IDs, URLs, or promises of success.",
    parameters: Type.Object({
      message: Type.String({
        description: `One concise ${language} sentence tailored to this issue`,
      }),
    }),
    async execute(_toolCallId, params) {
      if (calls >= MAX_PROGRESS_UPDATES) {
        throw new Error(
          `report_progress may be called at most ${MAX_PROGRESS_UPDATES} times per run`,
        )
      }
      calls++
      const message = params.message.trim()
      if (!message) throw new Error("message must not be empty")
      const body = `${message}\n\n${anchor}`
      if (status.id === undefined) {
        status.id = await seerr.postComment(issueId, body)
        return textResult(
          { posted: true, replacesPrevious: true },
          { action: "report_progress" },
        )
      }
      await seerr.updateComment(status.id, body)
      return textResult(
        { updated: true, replacesPrevious: true },
        { action: "report_progress" },
      )
    },
  })
}
