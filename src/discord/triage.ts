import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

export const DISCORD_TRIAGE_TOOL = "submit_discord_triage"

export interface DiscordTriageDecision {
  respond: boolean
  threadName: string
}

export interface DiscordTriageCapture {
  submissions: DiscordTriageDecision[]
}

/** Accept one typed decision made as the final and only tool call. */
export function parseDiscordTriage(
  capture: DiscordTriageCapture,
  finalToolNames: string[],
): DiscordTriageDecision | undefined {
  if (
    capture.submissions.length !== 1 ||
    finalToolNames.length !== 1 ||
    finalToolNames[0] !== DISCORD_TRIAGE_TOOL
  ) {
    return undefined
  }
  return capture.submissions[0]
}

/** Triage-only terminal output. The classifier gets no other tools. */
export function buildDiscordTriageTool(
  capture: DiscordTriageCapture,
): ToolDefinition {
  return defineTool({
    name: DISCORD_TRIAGE_TOOL,
    label: "Submit Discord triage",
    description:
      "Submit the final pass or ignore decision. Call this exactly once as the final action.",
    parameters: Type.Object({
      respond: Type.Boolean({
        description: "True only when blitzcrank should open a conversation",
      }),
      threadName: Type.String({
        maxLength: 80,
        description:
          "A short title in the message language, or an empty string when ignored",
      }),
    }),
    async execute(_toolCallId, params) {
      const decision = {
        respond: params.respond,
        threadName: params.threadName,
      }
      capture.submissions.push(decision)
      return {
        content: [{ type: "text" as const, text: "Discord triage submitted." }],
        details: decision,
        terminate: true,
      }
    },
  })
}
