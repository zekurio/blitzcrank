/** Subprocess fixture: exits only after Durable has committed a real checkpoint. */
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { defineTool } from "@earendil-works/pi-durable"
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite"
import { Type } from "typebox"

import { RunContext } from "../tools/context.ts"
import { runDurableTurn } from "./durable.ts"

const mode = process.argv[2]!
const file = process.argv[3]!
const terminalMode = ["mixed", "duplicate", "terminal-checkpoint"].includes(
  mode,
)
const commit = SqliteStorage.prototype.commit
SqliteStorage.prototype.commit = async function (writes, context) {
  if (
    mode === "terminal-checkpoint" &&
    writes.some(
      (write) =>
        write.type === "entry" && write.value.kind === "pi.tool-result",
    )
  )
    process.exit(17)
  const seq = await commit.call(this, writes, context)
  if (
    ["mixed", "duplicate"].includes(mode) &&
    writes.some(
      (write) => write.type === "entry" && write.value.kind === "pi.assistant",
    )
  )
    process.exit(17)
  return seq
}
const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
})
runtime.checkAuth = () => Promise.resolve({ type: "api_key" })
let requests = 0
runtime.streamSimple = () => {
  requests += 1
  if (mode === "prepared" || requests === 2) process.exit(17)
  const message: AssistantMessage = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    timestamp: 1,
    stopReason: "toolUse",
    content: (mode === "mixed"
      ? ["operation", "terminal"]
      : mode === "duplicate"
        ? ["terminal", "terminal"]
        : mode === "terminal-checkpoint"
          ? ["terminal"]
          : ["operation"]
    ).map((name, index) => ({
      type: "toolCall",
      name,
      id: `call-${index}`,
      arguments: {},
    })),
    usage: {
      input: 10,
      output: 3,
      cacheRead: 100,
      cacheWrite: 2,
      totalTokens: 115,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
    },
  }
  const stream = createAssistantMessageEventStream()
  stream.push({ type: "done", reason: "toolUse", message })
  return stream
}
const runContext = new RunContext()
const operation = defineTool({
  name: "operation",
  description: "test",
  parameters: Type.Object({}),
  ...(mode === "unsafe" ? {} : { replay: "safe" as const }),
  async execute() {
    if (mode === "unsafe" || mode === "safe-intent") process.exit(17)
    runContext.recordRead("sonarr", "/series", '{"id":42}')
    runContext.recordIdentity("sonarr", 42)
    runContext.recordPath("sonarr", "/media/reused")
    return { content: [] }
  },
})
const terminal = defineTool({
  name: "terminal",
  description: "test",
  parameters: Type.Object({}),
  replay: "safe",
  async execute() {
    return { content: [], details: { accepted: true } }
  },
})
await runDurableTurn({
  modelRuntime: runtime,
  modelSpec: "anthropic/claude-sonnet-4-5",
  tools: terminalMode ? [operation, terminal] : [operation],
  ...(terminalMode ? { terminalToolNames: ["terminal"] } : {}),
  systemPrompt: mode === "cancel" ? "trusted\n" : "trusted",
  prompt: "test",
  storageFile: file,
  requestId: "job-1",
  runContext,
  sessionFileRef: undefined,
  logPrefix: "crash",
  builtinRead: false,
  skillsDir: "skills",
})
