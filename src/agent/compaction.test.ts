import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"

import { runDurableTurn } from "./durable.ts"

function answer(text: string, error?: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    timestamp: 1,
    stopReason: error ? "error" : "stop",
    ...(error ? { errorMessage: error } : {}),
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

test("blocking compaction charges its summary and leaves no pending work on reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compaction-test-"))
  try {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
    })
    runtime.checkAuth = () => Promise.resolve({ type: "api_key" })
    const messages = [
      answer("old history ".repeat(20_000)),
      answer("", "prompt is too long: context window exceeded"),
      answer("continued"),
      answer("next submission"),
    ]
    let summaries = 0
    runtime.completeSimple = async () => {
      summaries += 1
      return answer("summary of prior conversation")
    }
    runtime.streamSimple = () => {
      const message = messages.shift()
      assert.ok(message, "unexpected inference")
      const stream = createAssistantMessageEventStream()
      if (message.stopReason === "error")
        stream.push({ type: "error", reason: "error", error: message })
      else stream.push({ type: "done", reason: "stop", message })
      return stream
    }
    const opts = {
      modelRuntime: runtime,
      tools: [],
      modelSpec: "anthropic/claude-sonnet-4-5",
      systemPrompt: "trusted",
      prompt: "test",
      requestId: "first",
      storageFile: path.join(directory, "conversation.sqlite"),
      sessionFileRef: undefined,
      logPrefix: "test",
      builtinRead: false,
      skillsDir: path.resolve("skills"),
    }
    await runDurableTurn(opts)
    const compacted = await runDurableTurn({ ...opts, requestId: "second" })
    assert.equal(compacted.text, "continued", JSON.stringify(compacted.failure))
    assert.equal(compacted.failure, undefined)
    assert.equal(summaries, 1)
    assert.equal(compacted.usage.newTokens, 45)
    const next = await runDurableTurn({ ...opts, requestId: "third" })
    assert.equal(next.text, "next submission")
    assert.equal(next.failure, undefined)
    assert.equal(next.usage.newTokens, 15)
    const repeated = await runDurableTurn({ ...opts, requestId: "second" })
    assert.deepEqual(repeated.usage, compacted.usage)
    assert.equal(messages.length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test(
  "native provider retry retains failed-attempt usage",
  { timeout: 15_000 },
  async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
    })
    runtime.checkAuth = () => Promise.resolve({ type: "oauth" })
    const messages = [
      answer("", "429 rate limit exceeded"),
      answer("recovered"),
    ]
    runtime.streamSimple = () => {
      const message = messages.shift()
      assert.ok(message)
      const stream = createAssistantMessageEventStream()
      if (message.stopReason === "error")
        stream.push({ type: "error", reason: "error", error: message })
      else stream.push({ type: "done", reason: "stop", message })
      return stream
    }
    const result = await runDurableTurn({
      modelRuntime: runtime,
      tools: [],
      modelSpec: "anthropic/claude-sonnet-4-5",
      systemPrompt: "trusted",
      prompt: "test",
      requestId: "retry",
      storageFile: undefined,
      sessionFileRef: undefined,
      logPrefix: "test",
      builtinRead: false,
      skillsDir: path.resolve("skills"),
    })
    assert.equal(result.text, "recovered")
    assert.equal(result.usage.newTokens, 30)
    assert.equal(result.usage.costUsd, undefined)
    assert.equal(messages.length, 0)
  },
)
