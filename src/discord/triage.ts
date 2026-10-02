import { StringEnum } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

export const DISCORD_TRIAGE_TOOL = "submit_discord_triage"

export interface DiscordTriageDecision {
  route: "ignore" | "answer" | "thread"
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
  const decision = capture.submissions[0]!
  if (
    decision.route !== "ignore" &&
    decision.route !== "answer" &&
    decision.route !== "thread"
  )
    return undefined
  if (decision.route === "thread" && decision.threadName.trim() === "")
    return undefined
  return decision
}

/** Triage-only terminal output. The classifier gets no other tools. */
export function buildDiscordTriageTool(
  capture: DiscordTriageCapture,
): ToolDefinition {
  return defineTool({
    name: DISCORD_TRIAGE_TOOL,
    label: "Submit Discord triage",
    description:
      "Choose an inline answer, private troubleshooting thread, or ignore. Call exactly once as the final action.",
    parameters: Type.Object({
      route: StringEnum(["ignore", "answer", "thread"] as const, {
        description:
          "answer for quick factual questions; thread for troubleshooting or service changes; ignore for unrelated chat",
      }),
      threadName: Type.String({
        maxLength: 100,
        description:
          "For thread: the actual full show or movie title plus a brief problem description. Preserve the media title; shorten the problem description first. No bot prefix. Otherwise empty.",
      }),
    }),
    async execute(_toolCallId, params) {
      const decision = {
        route: params.route,
        threadName: params.route === "thread" ? params.threadName.trim() : "",
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
