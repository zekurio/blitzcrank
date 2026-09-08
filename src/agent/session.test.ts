import assert from "node:assert/strict"
import test from "node:test"

import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import { runSessionEffect } from "./session.ts"

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
