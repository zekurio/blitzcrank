import type { JsonValue } from "@earendil-works/chord"
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context"
import type { Static, TSchema } from "@earendil-works/pi-ai"
import type {
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable"

function unavailable(): never {
  throw new Error("This tool test does not provide Durable runtime operations")
}

// Tools here use their host-owned dependencies, not Durable storage. Fail if
// a test starts depending on a runtime operation instead of silently stubbing it.
const api: ToolExecutionApi = {
  get taskId() {
    return unavailable()
  },
  get conversationId() {
    return unavailable()
  },
  callId: "test",
  get registry() {
    return unavailable()
  },
  env: undefined,
  outputWindow: undefined,
  agent: unavailable,
  output: unavailable,
  diagnostic: unavailable,
  details: unavailable,
  commit: unavailable,
  memo: unavailable,
  createTask: unavailable,
  getTask: unavailable,
  waitForTask: unavailable,
  conversation: unavailable,
  watchDoc: unavailable,
  snapshot: unavailable,
  snapshotAsOf: unavailable,
}

export function executeTool<
  Parameters extends TSchema,
  Details extends JsonValue,
>(
  tool: ToolRegistration<Parameters, Details>,
  args: Static<Parameters>,
  signal?: AbortSignal,
) {
  return tool.execute(
    args,
    api,
    signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
  )
}
