import assert from "node:assert/strict"
import test from "node:test"

import type { Config } from "../config.ts"
import { RunContext } from "../tools/context.ts"
import {
  buildDiscordTools,
  buildServiceTools,
  type SessionFileRef,
} from "../tools/index.ts"
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

test("Discord conversations receive mutations and conversation history", () => {
  const config: Config = {
    port: 0,
    dataDir: "/tmp/blitzcrank-test",
    automationsDir: "/tmp/blitzcrank-test/automations",
    webhookSecret: undefined,
    model: undefined,
    automationModel: undefined,
    automationModels: {},
    authPath: undefined,
    modelsPath: undefined,
    language: "English",
    web: { provider: "none" },
    seerrBotUserId: undefined,
    seerrBotUsername: undefined,
    seerr: { url: "http://seerr.test", apiKey: "test" },
    sonarr: { url: "http://sonarr.test", apiKey: "test" },
    radarr: { url: "http://radarr.test", apiKey: "test" },
    sabnzbd: { url: "http://sabnzbd.test", apiKey: "test" },
    jellyfin: { url: "http://jellyfin.test", apiKey: "test" },
    anvil: { command: "anvilctl", socket: "/tmp/anvil.sock" },
    media: { roots: ["/tmp/media"] },
    discord: undefined,
  }
  const allRef: SessionFileRef = { current: undefined }
  const discordRef: SessionFileRef = { current: undefined }
  const allNames = buildServiceTools(config, new RunContext(), allRef).map(
    (tool) => tool.name,
  )
  const discordNames = buildDiscordTools(
    config,
    new RunContext(),
    discordRef,
  ).map((tool) => tool.name)

  assert.deepEqual(discordNames, allNames)
  assert.ok(discordNames.includes("thread_history_search"))
  assert.ok(discordNames.includes("seerr_create_request"))
  assert.ok(discordNames.includes("sonarr_delete_episode_file"))
  assert.ok(discordNames.includes("radarr_delete_movie_file"))
  assert.ok(discordNames.includes("sabnzbd_delete_job"))
  assert.ok(discordNames.includes("jellyfin_refresh_item"))
  assert.ok(discordNames.includes("anvil_retry_job"))
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
