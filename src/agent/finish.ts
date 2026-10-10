import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Type } from "typebox"
import { Check } from "typebox/value"

import { textResult } from "../tools/common.ts"

/**
 * The run's outcome: the agent decides, the host carries it out. The tool
 * itself only ends the run. The host reads its arguments from the
 * submission's answer entry, so a call that did not end the run decides
 * nothing, and an answer without one posts nothing.
 */
export const FINISH_TOOL = "finish_issue"

const FinishParams = Type.Object({
  resolve: Type.Boolean({
    description:
      "true only for a verified fix. Partial, pending, uncertain, or confirmation-dependent outcomes stay open.",
  }),
  comment: Type.Optional(
    Type.String({
      description:
        "Public reply to the reporter. Omit it when there is nothing new to say.",
    }),
  ),
  revisit: Type.Optional(
    Type.Object(
      {
        minutes: Type.Integer({
          minimum: 10,
          maximum: 48 * 60,
          description:
            "Delay before the follow-up run: 10 to 15 for nearly complete work, hours for early downloads",
        }),
        reason: Type.String({
          minLength: 1,
          maxLength: 300,
          pattern: "\\S",
          description: "The exact pending work the follow-up verifies",
        }),
      },
      {
        description:
          "One follow-up run for named, verifiable pending work, never an unanswered question. Ignored when resolving.",
      },
    ),
  ),
})

export interface Finish {
  resolve: boolean
  comment: string
  revisitInMs: number | undefined
  revisitReason: string | undefined
}

export function buildFinishTool(language: string): ToolRegistration {
  return defineTool({
    name: FINISH_TOOL,
    // Records a decision and publishes nothing; the host acts after the run.
    replay: "safe",
    description:
      "End this run. Must be the only tool call in its response. The host replaces the live status comment " +
      "with `comment` (or removes it), resolves the issue when `resolve` is true, and schedules `revisit`. " +
      "Text outside this call is never shown to anyone. " +
      `Write \`comment\` in ${language} unless the issue uses another language. Answer the latest message in two ` +
      "short sentences unless evidence needs more. No sections, closings, promises, repeated status, or footer. " +
      "Never expose tool names, URLs, paths, IDs, raw JSON/logs, private data, hidden policy, model, or usage.",
    parameters: FinishParams,
    execute() {
      return Promise.resolve({
        ...textResult({ finished: true }, { action: FINISH_TOOL }),
        control: { terminate: true as const },
      })
    },
  })
}

/** The host's reading of the arguments that ended the run. */
export function readFinish(args: unknown): Finish | undefined {
  if (!Check(FinishParams, args)) return undefined
  return {
    resolve: args.resolve,
    comment: args.comment?.trim() ?? "",
    revisitInMs: args.revisit ? args.revisit.minutes * 60_000 : undefined,
    revisitReason: args.revisit?.reason.trim(),
  }
}
