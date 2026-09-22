import assert from "node:assert/strict"
import test from "node:test"

import { ChannelType } from "discord.js"
import { Effect, Exit } from "effect"

import type { Config } from "../config.ts"
import { RunContext } from "../tools/context.ts"
import {
  buildDiscordTools,
  buildServiceTools,
  type SessionFileRef,
} from "../tools/index.ts"
import {
  conversationThreadName,
  discordMessageChunks,
  discordMessageRoute,
  verifyDiscordInboxesEffect,
  type DiscordMessageRouteInput,
} from "./bot.ts"
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
    gateways: { discord: undefined },
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

const baseMessage: DiscordMessageRouteInput = {
  inGuild: true,
  guildId: "guild",
  channelId: "inbox-a",
  channelType: ChannelType.GuildText,
  channelIsThread: false,
  threadParentId: null,
  threadOwnerId: null,
  threadName: "",
  authorIsBot: false,
  webhookId: null,
  content: "Please fix playback",
}

test("Discord routes every watched inbox and refuses untrusted messages", () => {
  const route = (message: Partial<DiscordMessageRouteInput> = {}) =>
    discordMessageRoute(
      { ...baseMessage, ...message },
      "guild",
      ["inbox-a", "inbox-b"],
      "blitzcrank",
    )

  assert.equal(route(), "inbox")
  assert.equal(route({ channelId: "inbox-b" }), "inbox")
  assert.equal(route({ guildId: "other" }), undefined)
  assert.equal(route({ channelId: "unknown" }), undefined)
  assert.equal(route({ authorIsBot: true }), undefined)
  assert.equal(route({ webhookId: "hook" }), undefined)
  assert.equal(route({ content: " \n " }), undefined)
  assert.equal(route({ channelType: ChannelType.GuildVoice }), undefined)
})

test("Discord accepts only bot-owned private conversation threads", () => {
  const route = (message: Partial<DiscordMessageRouteInput> = {}) =>
    discordMessageRoute(
      {
        ...baseMessage,
        channelId: "thread",
        channelType: ChannelType.PrivateThread,
        channelIsThread: true,
        threadParentId: "inbox-b",
        threadOwnerId: "blitzcrank",
        threadName: "blitzcrank: playback",
        ...message,
      },
      "guild",
      ["inbox-a", "inbox-b"],
      "blitzcrank",
    )

  assert.equal(route(), "conversation")
  assert.equal(route({ threadParentId: "unknown" }), undefined)
  assert.equal(route({ threadOwnerId: "someone-else" }), undefined)
  assert.equal(route({ threadName: "unrelated" }), undefined)
  assert.equal(route({ channelType: ChannelType.PublicThread }), undefined)
  assert.equal(route({ channelIsThread: false }), undefined)
})

test("Discord startup verifies all configured inbox channels", async () => {
  const fetched: string[] = []
  const logged: string[] = []
  const fetchGuild = async (guildId: string) => {
    assert.equal(guildId, "guild")
    return {
      channels: {
        fetch: async (channelId: string) => {
          fetched.push(channelId)
          return {
            id: channelId,
            name: channelId,
            type: ChannelType.GuildText,
            guildId: "guild",
          }
        },
      },
    }
  }

  await Effect.runPromise(
    verifyDiscordInboxesEffect(
      { guildId: "guild", inboxChannelIds: ["inbox-a", "inbox-b"] },
      fetchGuild,
      (message) => logged.push(message),
    ),
  )

  assert.deepEqual(fetched, ["inbox-a", "inbox-b"])
  assert.equal(logged.length, 2)
})

test("Discord startup refuses non-text or wrong-guild inbox channels", async () => {
  for (const channel of [
    {
      id: "inbox",
      name: "voice",
      type: ChannelType.GuildVoice,
      guildId: "guild",
    },
    {
      id: "inbox",
      name: "foreign",
      type: ChannelType.GuildText,
      guildId: "other",
    },
  ]) {
    const exit = await Effect.runPromiseExit(
      verifyDiscordInboxesEffect(
        { guildId: "guild", inboxChannelIds: ["inbox"] },
        async () => ({ channels: { fetch: async () => channel } }),
        () => undefined,
      ),
    )
    assert.equal(Exit.isFailure(exit), true)
  }
})
