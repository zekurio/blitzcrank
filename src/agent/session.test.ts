import assert from "node:assert/strict"
import test from "node:test"

import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type ToolCall,
} from "@earendil-works/pi-ai"
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import { Type } from "typebox"

import {
  AUTOMATION_REPORT_TOOL,
  buildAutomationReportTool,
  parseAutomationReport,
} from "../automations/report.ts"
import {
  buildDiscordTriageTool,
  DISCORD_TRIAGE_TOOL,
  parseDiscordTriage,
} from "../discord/triage.ts"
import { installTerminalToolGate, runSessionEffect } from "./session.ts"

const message: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Fresh answer" }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test",
  timestamp: 1,
  stopReason: "stop",
  usage: {
    input: 10,
    output: 3,
    cacheRead: 100,
    cacheWrite: 2,
    totalTokens: 115,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
  },
}

function sessionHarness() {
  const events: string[] = []
  let listener: ((event: AgentSessionEvent) => void) | undefined
  const session = {
    agent: {},
    sessionFile: "/test/session.jsonl",
    // A resumed transcript must never supply this turn's final answer.
    messages: [
      { ...message, content: [{ type: "text", text: "Stale answer" }] },
    ],
    bindExtensions: () => Promise.resolve(),
    subscribe(callback: (event: AgentSessionEvent) => void) {
      listener = callback
      return () => events.push("unsubscribe")
    },
    abort() {
      events.push("abort")
      return Promise.resolve()
    },
    prompt: () => Promise.resolve(),
    dispose() {
      events.push("dispose")
    },
  }
  const opts = {
    modelRuntime: {
      checkAuth: () => Promise.resolve({ type: "api_key" as const }),
    },
    modelSpec: "anthropic/test",
    sessionFileRef: { current: undefined as string | undefined },
    logPrefix: "session-test",
    prompt: "test",
  }
  return {
    session,
    opts,
    events,
    emit: (event: AgentSessionEvent) => listener?.(event),
  }
}

test("session cleanup covers setup failures and rejects stale resumed answers", async () => {
  for (const stage of ["bind", "auth", "prompt"] as const) {
    const h = sessionHarness()
    if (stage === "bind")
      h.session.bindExtensions = () => Promise.reject(new Error("bind failed"))
    if (stage === "auth")
      h.opts.modelRuntime.checkAuth = () =>
        Promise.reject(new Error("auth failed"))
    await assert.rejects(
      Effect.runPromise(runSessionEffect(h.session, h.opts, true)),
      stage === "prompt"
        ? /no assistant message/
        : new RegExp(`${stage} failed`),
    )
    assert.equal(h.events.at(-1), "dispose")
    assert.equal(h.events.filter((event) => event === "dispose").length, 1)
    assert.equal(h.events.includes("unsubscribe"), stage === "prompt")
  }
})

test("stopping waits for active tool verification and retains live usage", async () => {
  const h = sessionHarness()
  const stop = new AbortController()
  h.session.prompt = () => {
    h.emit({ type: "message_end", message })
    h.emit({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "write",
      args: {},
    })
    stop.abort()
    assert.equal(h.events.length, 0)
    h.events.push("verified")
    h.emit({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "write",
      result: {},
      isError: false,
    })
    return Promise.resolve()
  }
  const turn = await Effect.runPromise(
    runSessionEffect(h.session, { ...h.opts, signal: stop.signal }, true),
  )
  assert.deepEqual(h.events, ["verified", "abort", "unsubscribe", "dispose"])
  assert.equal(turn.text, "")
  assert.deepEqual(turn.finalToolNames, [])
  assert.equal(turn.usage.newTokens, 15)
  assert.equal(turn.usage.billedTokens, 115)
  assert.equal(turn.usage.costUsd, 0.1)
  assert.equal(turn.sessionFile, h.session.sessionFile)
  assert.equal(turn.resumed, true)
  assert.equal(h.opts.sessionFileRef.current, h.session.sessionFile)
})

test("successful sessions return only the live final answer", async () => {
  const h = sessionHarness()
  h.session.prompt = () => {
    h.emit({ type: "message_end", message })
    return Promise.resolve()
  }
  const turn = await Effect.runPromise(
    runSessionEffect(h.session, h.opts, true),
  )
  assert.equal(turn.text, "Fresh answer")
  assert.deepEqual(h.events, ["unsubscribe", "dispose"])
})

/** Exercise the installed SDK's parallel preparation and execution, not a mock. */
async function terminalSession(tools: ToolDefinition[], terminalName: string) {
  const cwd = process.cwd()
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "test",
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
  })
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime,
    model,
    resourceLoader: loader,
    customTools: tools,
    tools: tools.map((tool) => tool.name),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  })
  await session.bindExtensions({ mode: "print" })
  const restoreGate = installTerminalToolGate(session.agent, [terminalName])
  const errors: string[] = []
  session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.isError)
      errors.push(event.toolName)
  })
  return {
    session,
    errors,
    restoreGate,
    async batch(names: string[], args: ToolCall["arguments"]) {
      let streamed = false
      session.agent.streamFunction = () => {
        const stream = createAssistantMessageEventStream()
        const reason = streamed || names.length === 0 ? "stop" : "toolUse"
        const reply: AssistantMessage = {
          ...message,
          stopReason: reason,
          content: streamed
            ? []
            : names.map((name, index) => ({
                type: "toolCall" as const,
                id: `${name}-${index}`,
                name,
                arguments: name === terminalName ? args : {},
              })),
        }
        streamed = true
        stream.push({ type: "done", reason, message: reply })
        return stream
      }
      await session.agent.prompt("test")
    },
  }
}

test("terminal batches block reports and mutations in either order and duplicate submissions", async () => {
  for (const names of [
    [AUTOMATION_REPORT_TOOL, "mutate"],
    ["mutate", AUTOMATION_REPORT_TOOL],
    [AUTOMATION_REPORT_TOOL, AUTOMATION_REPORT_TOOL],
  ]) {
    const capture = { submissions: [] }
    let mutations = 0
    const mutate = defineTool({
      name: "mutate",
      label: "mutate",
      description: "test mutation",
      parameters: Type.Object({}),
      async execute() {
        mutations += 1
        return { content: [], details: {} }
      },
    })
    const h = await terminalSession(
      [mutate, buildAutomationReportTool(capture)],
      AUTOMATION_REPORT_TOOL,
    )
    try {
      await h.batch(names, { status: "ok", body: "unaccepted" })
      assert.equal(mutations, 0)
      assert.equal(capture.submissions.length, 0)
      assert.deepEqual(h.errors, names)
      assert.equal(parseAutomationReport(capture, names).malformed, true)

      await h.batch(["mutate"], {})
      assert.equal(mutations, 1)
      await h.batch([AUTOMATION_REPORT_TOOL], {
        status: "invalid",
        body: "schema failure",
      })
      assert.equal(capture.submissions.length, 0)
      await h.batch([AUTOMATION_REPORT_TOOL], {
        status: "ok",
        body: "accepted",
      })
      assert.deepEqual(capture.submissions, [
        { status: "ok", body: "accepted" },
      ])
      assert.equal(
        parseAutomationReport(capture, [AUTOMATION_REPORT_TOOL]).malformed,
        false,
      )
      await h.batch([AUTOMATION_REPORT_TOOL], {
        status: "fehler",
        body: "overwrite",
      })
      await h.batch(["mutate"], {})
      assert.equal(mutations, 1)
      assert.deepEqual(capture.submissions, [
        { status: "ok", body: "accepted" },
      ])
    } finally {
      h.session.dispose()
    }
  }
})

test("failed terminal execution permits correction and retains SDK hooks", async () => {
  let submissions = 0
  const terminal = defineTool({
    name: "terminal",
    label: "terminal",
    description: "test terminal",
    parameters: Type.Object({ fail: Type.Boolean() }),
    async execute(_id, params) {
      if (params.fail) throw new Error("submission failed")
      submissions += 1
      return { content: [], details: {}, terminate: true }
    },
  })
  const h = await terminalSession([terminal], "terminal")
  h.restoreGate()
  const before = h.session.agent.beforeToolCall
  const after = h.session.agent.afterToolCall
  const hooks: string[] = []
  h.session.agent.beforeToolCall = async (...args) => {
    hooks.push("before")
    return before?.(...args)
  }
  h.session.agent.afterToolCall = async (...args) => {
    hooks.push("after")
    return after?.(...args)
  }
  const observedBefore = h.session.agent.beforeToolCall
  const observedAfter = h.session.agent.afterToolCall
  const restore = installTerminalToolGate(h.session.agent, ["terminal"])
  try {
    await h.batch(["terminal"], { fail: true })
    assert.equal(submissions, 0)
    await h.batch(["terminal"], { fail: false })
    assert.equal(submissions, 1)
    assert.deepEqual(hooks, ["before", "after", "before", "after"])
    await h.batch(["terminal"], { fail: false })
    assert.equal(submissions, 1)
    assert.deepEqual(hooks, ["before", "after", "before", "after"])
    restore()
    assert.equal(h.session.agent.beforeToolCall, observedBefore)
    assert.equal(h.session.agent.afterToolCall, observedAfter)
  } finally {
    h.session.dispose()
  }
})

test("Discord terminal submissions normalize names and reject duplicates and later calls", async () => {
  for (const route of ["ignore", "answer", "thread"] as const) {
    const capture = { submissions: [] }
    const h = await terminalSession(
      [buildDiscordTriageTool(capture)],
      DISCORD_TRIAGE_TOOL,
    )
    try {
      await h.batch([DISCORD_TRIAGE_TOOL, DISCORD_TRIAGE_TOOL], {
        route,
        threadName: "  Media title  ",
      })
      assert.equal(capture.submissions.length, 0)
      await h.batch([DISCORD_TRIAGE_TOOL], {
        route,
        threadName: "  Media title  ",
      })
      await h.batch([DISCORD_TRIAGE_TOOL], {
        route: "thread",
        threadName: "overwrite",
      })
      assert.deepEqual(parseDiscordTriage(capture, [DISCORD_TRIAGE_TOOL]), {
        route,
        threadName: route === "thread" ? "Media title" : "",
      })
    } finally {
      h.session.dispose()
    }
  }
})
