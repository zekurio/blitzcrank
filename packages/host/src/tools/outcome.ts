import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Type } from "typebox"

import type { Channel } from "../gateway.ts"
import { textResult } from "./common.ts"

/**
 * What a run asked the host to do once its reply is out. The tool below only
 * records here. The host acts after the run, so a run that fails leaves the
 * thread open.
 */
export interface RunIntents {
  close: boolean
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
