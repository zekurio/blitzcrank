import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Effect } from "effect"
import { Type } from "typebox"

import type { Channel } from "../gateway.ts"
import { textResult, toolCheck } from "./common.ts"

export const REVISIT_TOOL = "schedule_revisit"

/** Longest delay a run may ask for. The scheduler caps at the same bound. */
export const MAX_REVISIT_MINUTES = 48 * 60

/**
 * What a run asked the host to do once its reply is out. The tools below only
 * record here. The host acts after the run, so a run that fails or is stopped
 * leaves no timer armed and no thread closed.
 */
export interface RunIntents {
  revisit: { minutes: number; reason: string } | undefined
  close: boolean
}

export function buildRevisitTool(
  intents: RunIntents,
  revisitsLeft: number,
): ToolRegistration {
  return defineTool({
    name: REVISIT_TOOL,
    // Records a request and writes nothing, so a rerun is harmless.
    replay: "safe",
    description:
      "Ask for one later run on this thread, to verify named pending work such as a download or an import. " +
      "Never for an unanswered question. The host arms it after your final message, and a later call replaces " +
      "an earlier one. That run's final message is posted like any other.",
    parameters: Type.Object({
      minutes: Type.Integer({
        minimum: 10,
        maximum: MAX_REVISIT_MINUTES,
        description:
          "Delay before that run: 10 to 15 for nearly complete work, hours for early downloads",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: 300,
        pattern: "\\S",
        description: "The exact pending work that run verifies",
      }),
    }),
    execute(params) {
      return Effect.runPromise(
        toolCheck(() => {
          if (revisitsLeft <= 0) {
            throw new Error(
              "No revisits are left for this thread. Give your conclusion, or ask the reporter one concrete question.",
            )
          }
          intents.revisit = {
            minutes: params.minutes,
            reason: params.reason.trim(),
          }
          return textResult(
            { recorded: true, minutes: params.minutes },
            { action: REVISIT_TOOL },
          )
        }),
      )
    },
  })
}

/** The gateway names and describes the tool; closing stays the host's act. */
export function buildCloseTool(
  close: NonNullable<Channel["close"]>,
  intents: RunIntents,
): ToolRegistration {
  return defineTool({
    name: close.tool,
    // Records a request and writes nothing, so a rerun is harmless.
    replay: "safe",
    description: close.description,
    parameters: Type.Object({}),
    execute() {
      intents.close = true
      return Promise.resolve(
        textResult({ recorded: true }, { action: close.tool }),
      )
    },
  })
}
