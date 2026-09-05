import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

import { buildHistoryTool } from "./history.ts"

interface SearchOutput {
  results: Array<{ source: string; snippet: string }>
}

async function execute(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<SearchOutput> {
  const result = await tool.execute(
    "test",
    params,
    undefined,
    undefined,
    undefined as never,
  )
  const content = result.content[0]
  assert.ok(content && content.type === "text")
  return JSON.parse(content.text) as SearchOutput
}

test("conversation history search is route-scoped and excludes itself", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-history-test-"))
  try {
    const issues = path.join(root, "issues")
    const automations = path.join(root, "automations")
    const currentDiscord = path.join(root, "discord", "123")
    const otherDiscord = path.join(root, "discord", "456")
    await Promise.all([
      mkdir(issues, { recursive: true }),
      mkdir(automations, { recursive: true }),
      mkdir(currentDiscord, { recursive: true }),
      mkdir(otherDiscord, { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(issues, "issue.jsonl"), "needle seerr"),
      writeFile(
        path.join(automations, "automation.jsonl"),
        "needle automation",
      ),
      writeFile(path.join(otherDiscord, "other.jsonl"), "needle discord"),
      writeFile(
        path.join(currentDiscord, "stale.jsonl"),
        "needle stale current thread",
      ),
    ])
    const current = path.join(currentDiscord, "current.jsonl")
    await writeFile(current, "needle active current thread")

    const discordTool = buildHistoryTool(root, { current }, [
      "issues",
      "discord",
    ])
    const discordResults = await execute(discordTool, {
      query: "needle",
      source: "all",
      limit: 10,
    })

    assert.deepEqual(
      discordResults.results.map((result) => result.source).sort(),
      ["discord", "seerr"],
    )
    assert.ok(
      discordResults.results.every(
        (result) => !result.snippet.includes("current thread"),
      ),
    )
    await assert.rejects(
      execute(discordTool, { query: "needle", source: "automations" }),
      /not available in this run/,
    )

    const defaultTool = buildHistoryTool(root, { current: undefined })
    const defaultResults = await execute(defaultTool, {
      query: "needle",
      source: "all",
      limit: 10,
    })
    assert.deepEqual(
      defaultResults.results.map((result) => result.source).sort(),
      ["automation", "seerr"],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
