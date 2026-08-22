import assert from "node:assert/strict"
import test from "node:test"

import { conversationThreadName, discordMessageChunks } from "./bot.ts"
import {
  DISCORD_TRIAGE_TOOL,
  parseDiscordTriage,
  type DiscordTriageCapture,
} from "./triage.ts"

test("triage accepts one final typed submission", () => {
  const capture: DiscordTriageCapture = {
    submissions: [
      {
        respond: true,
        threadName: "Playback problem",
      },
    ],
  }

  assert.deepEqual(parseDiscordTriage(capture, [DISCORD_TRIAGE_TOOL]), {
    respond: true,
    threadName: "Playback problem",
  })
  assert.equal(
    parseDiscordTriage(capture, [DISCORD_TRIAGE_TOOL, "another_tool"]),
    undefined,
  )
})

test("Discord output stays inside platform limits", () => {
  const response = `${"a".repeat(1899)}😀${"b".repeat(1901)}`
  const chunks = discordMessageChunks(response)

  assert.ok(chunks.every((chunk) => chunk.length <= 1900))
  assert.equal(chunks.join(""), response)
  assert.equal(
    conversationThreadName(`  Playback\n${"x".repeat(120)}  `).length,
    100,
  )
})
