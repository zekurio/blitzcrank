import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type ToolCall,
} from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite"
import { Effect, Fiber } from "effect"
import { Type } from "typebox"

import { ToolError } from "../tools/common.ts"
import { RunContext } from "../tools/context.ts"
import { guardModelRequests } from "./durable-model.ts"
import { openDurableStorage, runDurableTurn } from "./durable.ts"
import { runAgentTurnEffect, type AgentTurnOptions } from "./session.ts"

function answer(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    timestamp: 1,
    stopReason: content.some((block) => block.type === "toolCall")
      ? "toolUse"
      : "stop",
    usage: {
      input: 10,
      output: 3,
      cacheRead: 100,
      cacheWrite: 2,
      totalTokens: 115,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
    },
  }
}

function calls(...names: string[]): ToolCall[] {
  return names.map((name, index) => ({
    type: "toolCall",
    name,
    id: `${name}-${index}`,
    arguments: {},
  }))
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function scripted(messages: AssistantMessage[]) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
  })
  let requests = 0
  runtime.checkAuth = () => Promise.resolve({ type: "api_key" })
  runtime.streamSimple = () => {
    requests += 1
    const message = messages.shift()
    assert.ok(message, "unexpected provider request")
    const stream = createAssistantMessageEventStream()
    stream.push({
      type: "done",
      reason: message.stopReason as "stop" | "toolUse",
      message,
    })
    return stream
  }
  return { runtime, requests: () => requests }
}

function options(
  modelRuntime: ModelRuntime,
  tools: ToolRegistration[] = [],
): AgentTurnOptions & { skillsDir: string } {
  return {
    modelRuntime,
    tools,
    modelSpec: "anthropic/claude-sonnet-4-5",
    systemPrompt: "trusted",
    prompt: "test",
    requestId: "job-1",
    storageFile: undefined,
    sessionFileRef: undefined,
    logPrefix: "test",
    builtinRead: false,
    skillsDir: path.resolve("skills"),
  }
}

test("abort during asynchronous initialization cannot start provider or tool work", async () => {
  const provider = await scripted([answer(calls("mutate"))])
  const controller = new AbortController()
  provider.runtime.checkAuth = async () => {
    controller.abort()
    return { type: "api_key" }
  }
  let writes = 0
  const mutate = defineTool({
    name: "mutate",
    description: "fake write",
    parameters: Type.Object({}),
    execute: async () => {
      writes++
      return {}
    },
  })
  const result = await runDurableTurn({
    ...options(provider.runtime, [mutate]),
    signal: controller.signal,
  })
  assert.equal(provider.requests(), 0)
  assert.equal(writes, 0)
  assert.equal(result.text, "")
})

test("the provider boundary covers deferred fetch and compaction completion too", async (t) => {
  const provider = await scripted([])
  const methods = [
    "stream",
    "complete",
    "streamSimple",
    "completeSimple",
    "streamDeferred",
    "fetchDeferred",
    "generateImages",
    "classify",
  ] as const
  let requests = 0
  for (const method of methods)
    t.mock.method(provider.runtime, method, () => {
      requests++
      throw new Error("provider invoked")
    })
  const guarded = guardModelRequests(provider.runtime, () => {
    throw new Error("run stopped")
  })
  for (const method of methods)
    assert.throws(
      () => Reflect.apply(guarded[method], guarded, []),
      /run stopped/,
    )
  assert.equal(requests, 0)
  assert.ok(guarded.getModel("anthropic", "claude-sonnet-4-5"))
})

test("SQLite deduplicates exact submissions and retrieves their own answer after later runs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "durable-test-"))
  try {
    const provider = await scripted([
      answer([{ type: "text", text: "First" }]),
      answer([{ type: "text", text: "Second" }]),
    ])
    const opts = {
      ...options(provider.runtime),
      storageFile: path.join(directory, "conversation.sqlite"),
    }
    const first = await runDurableTurn(opts)
    assert.equal(first.text, "First")
    assert.equal(first.resumed, false)
    await runDurableTurn({ ...opts, requestId: "job-2" })
    const restored = await runDurableTurn(opts)
    assert.equal(restored.text, "First")
    assert.equal(restored.resumed, true)
    assert.equal(provider.requests(), 2)
    assert.deepEqual(restored.usage, first.usage)
    assert.equal(first.usage.newTokens, 15)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("terminal barrier blocks every sibling in mixed and duplicate rounds", async () => {
  for (const names of [
    ["terminal", "mutate"],
    ["mutate", "terminal"],
    ["terminal", "terminal"],
  ]) {
    let writes = 0
    let reports = 0
    const provider = await scripted([
      answer(calls(...names)),
      answer([{ type: "text", text: "done" }]),
    ])
    const mutate = defineTool({
      name: "mutate",
      description: "test",
      parameters: Type.Object({}),
      async execute() {
        writes += 1
        return { content: [] }
      },
    })
    const terminal = defineTool({
      name: "terminal",
      description: "test",
      parameters: Type.Object({}),
      async execute() {
        reports += 1
        return {
          content: [],
          details: { status: "ok" },
          control: { terminate: true },
        }
      },
    })
    const result = await runDurableTurn({
      ...options(provider.runtime, [mutate, terminal]),
      terminalToolNames: ["terminal"],
    })
    assert.equal(writes, 0)
    assert.equal(reports, 0)
    assert.deepEqual(result.terminalToolResults, [])
  }
})

test("completed terminal details and counts survive reopen without repeating tools", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "durable-terminal-"))
  try {
    let executions = 0
    const provider = await scripted([answer(calls("terminal"))])
    const terminal = defineTool({
      name: "terminal",
      description: "test",
      parameters: Type.Object({}),
      async execute() {
        executions += 1
        return {
          content: [],
          details: { status: "ok" },
          control: { terminate: true },
        }
      },
    })
    const opts = {
      ...options(provider.runtime, [terminal]),
      terminalToolNames: ["terminal"],
      storageFile: path.join(directory, "run.sqlite"),
    }
    const first = await runDurableTurn(opts)
    const second = await runDurableTurn(opts)
    assert.equal(executions, 1)
    assert.deepEqual(second.terminalToolResults, first.terminalToolResults)
    assert.deepEqual(second.successfulToolCounts, { terminal: 1 })
    assert.deepEqual(second.finalToolNames, ["terminal"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("evidence and audit survive reopening, but path permissions do not", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "durable-evidence-"))
  try {
    const runContext = new RunContext()
    const provider = await scripted([
      answer(calls("read_service")),
      answer([{ type: "text", text: "done" }]),
    ])
    const tool = defineTool({
      name: "read_service",
      description: "test",
      replay: "safe",
      parameters: Type.Object({}),
      async execute() {
        runContext.recordRead("sonarr", "/series", '{"id":42}')
        runContext.recordIdentity("sonarr", 42)
        runContext.recordPath("sonarr", "/media/file")
        runContext.noteMutation("delete")
        return { content: [] }
      },
    })
    const opts = {
      ...options(provider.runtime, [tool]),
      runContext,
      storageFile: path.join(directory, "run.sqlite"),
    }
    await runDurableTurn(opts)
    const recovered = new RunContext()
    await runDurableTurn({ ...opts, runContext: recovered })
    assert.equal(recovered.sawIdentity("sonarr", 42), true)
    assert.equal(recovered.sawRecordedPath("/media/file"), false)
    assert.deepEqual(recovered.counts, { mutations: 1, deletes: 1 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("stop waits for active write and verification and retains usage", async () => {
  const stop = new AbortController()
  const events: string[] = []
  const provider = await scripted([answer(calls("mutate"))])
  const tool = defineTool({
    name: "mutate",
    description: "test",
    parameters: Type.Object({}),
    async execute() {
      events.push("write")
      stop.abort()
      await new Promise((resolve) => setTimeout(resolve, 10))
      events.push("verify")
      return { content: [] }
    },
  })
  const result = await Effect.runPromise(
    runAgentTurnEffect({
      ...options(provider.runtime, [tool]),
      signal: stop.signal,
    }),
  )
  assert.deepEqual(events, ["write", "verify"])
  assert.equal(result.text, "")
  assert.equal(result.usage.newTokens, 15)
  assert.deepEqual(result.successfulToolCounts, { mutate: 1 })
})

test("prepared request and safe tool intent recover from process crash", async () => {
  for (const mode of ["prepared", "safe-intent", "completed-read"]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "durable-crash-"))
    try {
      const file = path.join(directory, "run.sqlite")
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/agent/durable-crash-helper.ts", mode, file],
        { encoding: "utf8" },
      )
      assert.equal(child.status, 17, child.stderr)
      let executions = 0
      const runContext = new RunContext()
      const operation = defineTool({
        name: "operation",
        description: "test",
        parameters: Type.Object({}),
        replay: "safe",
        async execute() {
          executions += 1
          runContext.recordRead("sonarr", "/series", '{"id":42}')
          runContext.recordIdentity("sonarr", 42)
          return { content: [] }
        },
      })
      const provider = await scripted([
        answer([{ type: "text", text: "Recovered" }]),
      ])
      const recovered = await runDurableTurn({
        ...options(provider.runtime, [operation]),
        runContext,
        storageFile: file,
      })
      assert.equal(recovered.text, "Recovered")
      assert.equal(recovered.failure, undefined)
      assert.equal(executions, mode === "safe-intent" ? 1 : 0)
      if (mode !== "prepared") {
        assert.equal(runContext.sawIdentity("sonarr", 42), true)
        assert.equal(runContext.sawRecordedPath("/media/reused"), false)
        assert.equal(recovered.usage.newTokens, 30)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test("unsafe crash prevents replay and any new provider mutation proposal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "durable-unsafe-"))
  try {
    const file = path.join(directory, "run.sqlite")
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/agent/durable-crash-helper.ts", "unsafe", file],
      { encoding: "utf8" },
    )
    assert.equal(child.status, 17, child.stderr)
    let writes = 0
    const operation = defineTool({
      name: "operation",
      description: "test",
      parameters: Type.Object({}),
      async execute() {
        writes += 1
        return { content: [] }
      },
    })
    const provider = await scripted([])
    const opts = {
      ...options(provider.runtime, [operation]),
      storageFile: file,
    }
    const recovered = await runDurableTurn(opts)
    assert.equal(recovered.failure?.kind, "unsafe-interrupted")
    assert.equal(recovered.text, "")
    assert.equal(provider.requests(), 0)
    assert.equal(writes, 0)
    const again = await runDurableTurn(opts)
    assert.equal(again.failure?.kind, "unsafe-interrupted")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("changed policy aborts prepared work before provider or tools execute", async () => {
  for (const change of ["prompt", "allowlist", "model"] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "durable-policy-"))
    try {
      const file = path.join(directory, "run.sqlite")
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/agent/durable-crash-helper.ts",
          "prepared",
          file,
        ],
        { encoding: "utf8" },
      )
      assert.equal(child.status, 17, child.stderr)
      const provider = await scripted([])
      const operation = defineTool({
        name: "operation",
        description: "test",
        replay: "safe",
        parameters: Type.Object({}),
        async execute() {
          assert.fail("revoked work executed")
        },
      })
      const opts = {
        ...options(provider.runtime, [operation]),
        storageFile: file,
      }
      const result = await runDurableTurn({
        ...opts,
        ...(change === "prompt"
          ? { systemPrompt: "new scope" }
          : change === "allowlist"
            ? { tools: [] }
            : { modelSpec: "anthropic/other" }),
      })
      assert.equal(result.failure?.kind, "policy-changed")
      assert.equal(provider.requests(), 0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test("unsafe verification failure blocks sibling writes and preserves audit and host handles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "durable-verify-"))
  try {
    const provider = await scripted([answer(calls("mutate", "mutate"))])
    const runContext = new RunContext()
    let writes = 0
    let statusId = 0
    const mutate = defineTool({
      name: "mutate",
      description: "test",
      parameters: Type.Object({}),
      async execute() {
        writes += 1
        statusId = 42
        runContext.noteMutation("delete")
        throw new Error("verification failed after accepted write")
      },
    })
    const opts = {
      ...options(provider.runtime, [mutate]),
      runContext,
      storageFile: path.join(directory, "run.sqlite"),
      hostState: {
        capture: () => ({ statusId }),
        restore(value: unknown) {
          assert.ok(value && typeof value === "object" && "statusId" in value)
          statusId = value.statusId as number
        },
      },
    }
    const result = await runDurableTurn(opts)
    assert.equal(result.failure?.kind, "unsafe-interrupted")
    assert.equal(writes, 1)
    assert.equal(provider.requests(), 1)
    statusId = 0
    const recovered = new RunContext()
    await runDurableTurn({ ...opts, runContext: recovered })
    assert.equal(statusId, 42)
    assert.deepEqual(recovered.counts, { mutations: 1, deletes: 1 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("OAuth usage remains dollar-free even if credentials change before answer retrieval", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "durable-oauth-"))
  try {
    const provider = await scripted([
      answer([{ type: "text", text: "subscription" }]),
    ])
    provider.runtime.checkAuth = () => Promise.resolve({ type: "oauth" })
    const opts = {
      ...options(provider.runtime),
      storageFile: path.join(directory, "run.sqlite"),
    }
    const first = await runDurableTurn(opts)
    provider.runtime.checkAuth = () => Promise.resolve({ type: "api_key" })
    const restored = await runDurableTurn(opts)
    assert.equal(first.usage.costUsd, undefined)
    assert.deepEqual(restored.usage, first.usage)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Effect interruption joins write verification before closing execution", async () => {
  const entered = deferred()
  const release = deferred()
  const events: string[] = []
  const provider = await scripted([answer(calls("mutate"))])
  const mutate = defineTool({
    name: "mutate",
    description: "test",
    parameters: Type.Object({}),
    async execute() {
      events.push("write")
      entered.resolve()
      await release.promise
      events.push("verify")
      return { content: [] }
    },
  })
  const fiber = Effect.runFork(
    runAgentTurnEffect(options(provider.runtime, [mutate])),
  )
  await entered.promise
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(() =>
    events.push("closed"),
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(events, ["write"])
  release.resolve()
  await interrupted
  assert.deepEqual(events, ["write", "verify", "closed"])
  assert.equal(provider.requests(), 1)
})

test("typed pre-write refusal permits correction without weakening uncertain-write stop", async () => {
  const runContext = new RunContext()
  let attempts = 0
  const provider = await scripted([
    answer(calls("mutate")),
    answer(calls("mutate")),
    answer([{ type: "text", text: "corrected" }]),
  ])
  const mutate = defineTool({
    name: "mutate",
    description: "test",
    parameters: Type.Object({}),
    async execute() {
      attempts += 1
      if (attempts === 1)
        throw new ToolError({ message: "read the target first" })
      runContext.noteMutation("mutate")
      return { content: [] }
    },
  })
  const result = await runDurableTurn({
    ...options(provider.runtime, [mutate]),
    runContext,
  })
  assert.equal(result.failure, undefined)
  assert.equal(result.text, "corrected")
  assert.equal(attempts, 2)
  assert.deepEqual(result.successfulToolCounts, { mutate: 1 })
})

test("already-aborted recovery restores host state and usage without a provider call", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "durable-cancel-"))
  try {
    const file = path.join(directory, "run.sqlite")
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/agent/durable-crash-helper.ts", "cancel", file],
      { encoding: "utf8" },
    )
    assert.equal(child.status, 17, child.stderr)
    const provider = await scripted([])
    const operation = defineTool({
      name: "operation",
      description: "test",
      parameters: Type.Object({}),
      replay: "safe",
      async execute() {
        assert.fail("cancelled tool executed")
      },
    })
    const runContext = new RunContext()
    const stop = new AbortController()
    stop.abort()
    const result = await Effect.runPromise(
      runAgentTurnEffect({
        ...options(provider.runtime, [operation]),
        runContext,
        storageFile: file,
        signal: stop.signal,
      }),
    )
    assert.equal(result.text, "")
    assert.equal(result.usage.newTokens, 15)
    assert.equal(result.failure, undefined)
    assert.equal(runContext.sawIdentity("sonarr", 42), true)
    assert.equal(provider.requests(), 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("SQLite uses FULL on the connection that owns the storage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "durable-full-"))
  const nativeOpen = SqliteStorage.open
  let synchronous: number | undefined
  SqliteStorage.open = async (database) => {
    synchronous = (
      await database.get<{ synchronous: number }>("PRAGMA synchronous")
    )?.synchronous
    return nativeOpen(database)
  }
  try {
    const storage = await openDurableStorage(path.join(directory, "run.sqlite"))
    await storage.close(BACKGROUND_CONTEXT)
    assert.equal(synchronous, 2)
  } finally {
    SqliteStorage.open = nativeOpen
    await rm(directory, { recursive: true, force: true })
  }
})

test("builtin read is deployment-only, resolves symlinks, and is absent in triage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "durable-skills-"))
  try {
    const skillsDir = path.join(directory, "skills")
    await mkdir(skillsDir)
    await writeFile(path.join(skillsDir, "SKILL.md"), "trusted skill")
    await writeFile(path.join(directory, "secret.md"), "not a skill")
    await symlink(
      path.join(directory, "secret.md"),
      path.join(skillsDir, "outside.md"),
    )
    for (const [builtinRead, file, allowed] of [
      [true, "SKILL.md", true],
      [true, "outside.md", false],
      [false, "SKILL.md", false],
    ] as const) {
      const provider = await scripted([
        answer([
          {
            type: "toolCall",
            id: "read",
            name: "read",
            arguments: { path: file },
          },
        ]),
        answer([{ type: "text", text: "done" }]),
      ])
      const result = await runDurableTurn({
        ...options(provider.runtime),
        skillsDir,
        builtinRead,
      })
      assert.deepEqual(result.successfulToolCounts, allowed ? { read: 1 } : {})
      assert.equal(result.failure, undefined)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("safe failed terminal can be corrected; successful terminal ends all execution", async () => {
  let executions = 0
  const provider = await scripted([
    answer(calls("terminal")),
    answer(calls("terminal")),
  ])
  const terminal = defineTool({
    name: "terminal",
    description: "test",
    replay: "safe",
    parameters: Type.Object({}),
    async execute() {
      executions += 1
      if (executions === 1) throw new Error("correctable report error")
      return { content: [], details: { accepted: true } }
    },
  })
  const result = await runDurableTurn({
    ...options(provider.runtime, [terminal]),
    terminalToolNames: ["terminal"],
  })
  assert.equal(result.failure, undefined)
  assert.equal(executions, 2)
  assert.equal(provider.requests(), 2)
  assert.deepEqual(
    result.terminalToolResults.map((result) => result.details),
    [{ accepted: true }],
  )
})

test("terminal barrier and same-task terminal checkpoint recovery survive crashes", async () => {
  for (const mode of ["mixed", "duplicate", "terminal-checkpoint"]) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "durable-terminal-crash-"),
    )
    try {
      const file = path.join(directory, "run.sqlite")
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/agent/durable-crash-helper.ts", mode, file],
        { encoding: "utf8" },
      )
      assert.equal(child.status, 17, child.stderr)
      const provider = await scripted(
        mode === "terminal-checkpoint"
          ? []
          : [answer([{ type: "text", text: "done" }])],
      )
      const operation = defineTool({
        name: "operation",
        description: "test",
        parameters: Type.Object({}),
        replay: "safe",
        async execute() {
          assert.fail("mixed terminal sibling executed")
        },
      })
      const terminal = defineTool({
        name: "terminal",
        description: "test",
        parameters: Type.Object({}),
        replay: "safe",
        async execute() {
          assert.fail("terminal replay repeated capture")
        },
      })
      const opts = {
        ...options(provider.runtime, [operation, terminal]),
        terminalToolNames: ["terminal"],
        storageFile: file,
      }
      const recovered = await runDurableTurn(opts)
      assert.equal(recovered.failure, undefined)
      assert.deepEqual(
        recovered.successfulToolCounts,
        mode === "terminal-checkpoint" ? { terminal: 1 } : {},
      )
      if (mode === "terminal-checkpoint") {
        assert.deepEqual(
          recovered.terminalToolResults.map((result) => result.details),
          [{ accepted: true }],
        )
        assert.equal(provider.requests(), 0)
      }
      const again = await runDurableTurn(opts)
      assert.deepEqual(again.terminalToolResults, recovered.terminalToolResults)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})
