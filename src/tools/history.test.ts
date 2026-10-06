import assert from "node:assert/strict"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  AssistantEntry,
  type ConversationId,
  type EntryDraft,
  ROOT_CONVERSATION_ID,
  type ToolRegistration,
  UserEntry,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"

import { buildHistoryTool } from "./history.js"
import { executeTool } from "./test-fixture.js"

interface SearchOutput {
  results: Array<{ source: string; snippet: string }>
  skipped: number
}

type HistoryEntry = Omit<EntryDraft, "head">

async function search(tool: ToolRegistration, params: Record<string, unknown>) {
  const result = await executeTool(tool, params)
  const content = result.content?.[0]
  assert.ok(content && content.type === "text")
  return JSON.parse(content.text) as SearchOutput
}

const user = (text: string): HistoryEntry => ({
  kind: UserEntry.kind,
  model: [{ role: "user", content: text, timestamp: 1 }],
})

async function durable(file: string, entries: HistoryEntry[]) {
  const storage = await openNodeSqliteStorage(file, {
    walAutoCheckpointPages: 0,
  })
  await storage.commit(
    [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
    BACKGROUND_CONTEXT,
  )
  for (const entry of entries) {
    await storage.commit(
      [
        {
          type: "entry",
          value: {
            ...entry,
            id: await storage.mintId(),
            conversationId: ROOT_CONVERSATION_ID,
          },
        },
      ],
      BACKGROUND_CONTEXT,
    )
  }
  return storage
}

test("Durable history preserves route scopes and ignores legacy and automation files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-history-"))
  try {
    const issue = path.join(root, "issues", "1.sqlite")
    const current = path.join(root, "discord", "123", "conversation.sqlite")
    const other = path.join(root, "discord", "456", "conversation.sqlite")
    for (const file of [
      issue,
      current,
      other,
      path.join(root, "automations", "run.sqlite"),
    ]) {
      const storage = await durable(file, [user("needle " + file)])
      await storage.close(BACKGROUND_CONTEXT)
    }
    await writeFile(path.join(root, "issues", "2.jsonl"), "needle legacy")
    await writeFile(
      path.join(root, "discord", "123", "stale.jsonl"),
      "needle stale current thread",
    )
    const tool = buildHistoryTool(root, { current }, ["issues", "discord"])
    const output = await search(tool, { query: "needle", limit: 10 })
    assert.deepEqual(output.results.map((result) => result.source).sort(), [
      "discord",
      "seerr",
    ])
    assert.ok(output.results.every((result) => !result.snippet.includes(root)))
    assert.ok(output.results.every((result) => result.snippet.length <= 700))
    await assert.rejects(
      search(tool, { query: "needle", source: "automations" }),
      /not available in this run/,
    )
    const issueOnly = buildHistoryTool(root, { current: undefined })
    assert.deepEqual(
      (await search(issueOnly, { query: "needle" })).results.map(
        (r) => r.source,
      ),
      ["seerr"],
    )
    await assert.rejects(
      search(issueOnly, { query: "needle", source: "discord" }),
      /not available in this run/,
    )
    const ownIssue = buildHistoryTool(root, { current: issue })
    assert.equal(
      (await search(ownIssue, { query: "needle" })).results.length,
      0,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("history reads committed WAL text only without changing Durable storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-history-"))
  const file = path.join(root, "issues", "1.sqlite")
  const storage = await durable(file, [
    user("needle user text"),
    {
      kind: AssistantEntry.kind,
      model: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "needle assistant text" },
            { type: "thinking", thinking: "hiddenreason" },
            { type: "toolCall", id: "1", name: "hiddenargs", arguments: {} },
          ],
          api: "openai-responses",
          provider: "openai",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      ],
      data: { secret: "hiddendata" },
    },
    {
      kind: "pi.tool-result",
      model: [{ role: "user", content: "hiddentool", timestamp: 1 }],
    },
    {
      kind: "pi.compaction",
      model: [{ role: "user", content: "hiddensummary", timestamp: 1 }],
    },
  ])
  try {
    const child = await storage.mintId<ConversationId>()
    await storage.commit(
      [
        { type: "conversation", value: { id: child } },
        {
          type: "entry",
          value: {
            ...user("hiddenchild"),
            id: await storage.mintId(),
            conversationId: child,
          },
        },
      ],
      BACKGROUND_CONTEXT,
    )
    const before = await Promise.all([readFile(file), readFile(file + "-wal")])
    const tool = buildHistoryTool(root, { current: undefined })
    const found = await search(tool, { query: "needle" })
    assert.equal(found.results.length, 1)
    assert.match(found.results[0]!.snippet, /assistant text/)
    assert.match(found.results[0]!.snippet, /user text/)
    for (const query of [
      "hiddenreason",
      "hiddenargs",
      "hiddendata",
      "hiddentool",
      "hiddensummary",
      "hiddenchild",
    ])
      assert.equal((await search(tool, { query })).results.length, 0)
    assert.deepEqual(
      await Promise.all([readFile(file), readFile(file + "-wal")]),
      before,
    )
  } finally {
    await storage.close(BACKGROUND_CONTEXT)
    await rm(root, { recursive: true, force: true })
  }
})

test("history skips corrupt, unsupported, and symlink storage and enforces bounds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-history-"))
  try {
    const file = path.join(root, "issues", "1.sqlite")
    const storage = await durable(file, [
      user("ancientneedle"),
      ...Array.from({ length: 500 }, () => user("recentneedle")),
      user("oversizeneedle" + "x".repeat(64_000)),
    ])
    await storage.close(BACKGROUND_CONTEXT)
    const unsupported = path.join(root, "issues", "2.sqlite")
    const future = await durable(unsupported, [user("futureneedle")])
    await future.close(BACKGROUND_CONTEXT)
    const db = new DatabaseSync(unsupported)
    db.exec("UPDATE durable_schema SET version = 2")
    db.close()
    await writeFile(path.join(root, "issues", "3.sqlite"), "not sqlite")
    await symlink(file, path.join(root, "issues", "4.sqlite"))
    await mkdir(path.join(root, "issues", "nested"))
    const tool = buildHistoryTool(root, { current: undefined })
    assert.equal(
      (await search(tool, { query: "recentneedle" })).results.length,
      1,
    )
    for (const query of ["ancientneedle", "oversizeneedle", "futureneedle"])
      assert.equal((await search(tool, { query })).results.length, 0)
    assert.equal((await search(tool, { query: "recentneedle" })).skipped, 2)
    await assert.rejects(search(tool, { query: " " }), /query/)
    await assert.rejects(search(tool, { query: "x".repeat(501) }), /query/)
    await assert.rejects(search(tool, { query: "needle", limit: 11 }), /limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("history caps result count and snippet length", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-history-"))
  try {
    for (let id = 1; id <= 12; id++) {
      const storage = await durable(path.join(root, "issues", `${id}.sqlite`), [
        user("needle " + "text ".repeat(500)),
      ])
      await storage.close(BACKGROUND_CONTEXT)
    }
    const tool = buildHistoryTool(root, { current: undefined })
    assert.equal((await search(tool, { query: "needle" })).results.length, 5)
    const output = await search(tool, { query: "needle", limit: 10 })
    assert.equal(output.results.length, 10)
    assert.ok(output.results.every((result) => result.snippet.length === 700))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
