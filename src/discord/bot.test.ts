import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"

import {
  ChannelType,
  Client,
  Collection,
  Events,
  GatewayIntentBits,
} from "discord.js"
import { Effect } from "effect"

import type { DiscordConfig } from "../config.ts"
import type { ConversationRuntime } from "../gateways/chat/runtime.ts"
import { conversationSessionDir } from "./agent.ts"
import { DiscordBot } from "./bot.ts"

function discordFixture(t: TestContext, inboxes = true) {
  const config: DiscordConfig = {
    token: "test-token",
    guilds: ["100", "200"].map((guildId) => ({
      guildId,
      reportChannelId: `${guildId}1`,
      inboxChannelIds: inboxes ? [`${guildId}2`] : [],
      adminRoleIds: [`${guildId}3`],
      model: undefined,
      triageModel: undefined,
    })),
  }
  const clients: Client[] = []
  const commands: string[] = []
  const channels: string[] = []
  const reports: string[] = []
  const reportFailures = new Set<string>()
  const invalidChannels = new Set<string>()
  const login = t.mock.method(
    Client.prototype,
    "login",
    async function (this: Client, token: string) {
      assert.equal(token, config.token)
      clients.push(this)
      Object.defineProperty(this, "user", { value: { id: "999" } })
      Object.defineProperty(this, "application", {
        value: {
          commands: {
            set: async (_commands: unknown, guildId: string) => {
              assert.equal(this.listenerCount(Events.InteractionCreate), 0)
              assert.equal(this.listenerCount(Events.MessageCreate), 0)
              commands.push(guildId)
            },
          },
        },
      })
      t.mock.method(this.guilds, "fetch", async (guildId: string) => ({
        channels: {
          fetch: async (channelId: string) => {
            channels.push(channelId)
            return {
              id: channelId,
              guildId,
              name: channelId,
              type: invalidChannels.has(channelId)
                ? ChannelType.GuildVoice
                : ChannelType.GuildText,
              threads: {
                fetch: async () => ({ threads: new Collection() }),
                fetchArchived: async () => ({ threads: new Collection() }),
                create: async () => ({
                  id: `${guildId}4`,
                  send: async () => {
                    if (reportFailures.has(guildId))
                      throw new Error("report channel unavailable")
                    reports.push(guildId)
                  },
                }),
              },
            }
          },
        },
      }))
      // Exercise real construction and event registration without a network login.
      this.emit(Events.ClientReady, this as Client<true>)
      return token
    },
  )
  const destroy = Client.prototype.destroy
  const stop = t.mock.method(
    Client.prototype,
    "destroy",
    async function (this: Client) {
      await destroy.call(this)
    },
  )
  return {
    config,
    clients,
    commands,
    channels,
    reports,
    reportFailures,
    invalidChannels,
    login,
    stop,
  }
}

async function dispatch(client: Client, event: string, payload: unknown) {
  const listeners = client.listeners(event)
  assert.equal(listeners.length, 1)
  await Reflect.apply(listeners[0]!, client, [payload])
}

test("one Discord client routes commands and conversations across guilds", async (t) => {
  const fixture = discordFixture(t)
  const triggers: string[] = []
  const triaged: string[] = []
  const queued: string[] = []
  const chats = new Map<string, ConversationRuntime>(
    fixture.config.guilds.map((guild) => [
      guild.guildId,
      {
        triageEffect: () =>
          Effect.sync(() => {
            triaged.push(guild.guildId)
            return { respond: false, title: "" }
          }),
        enqueue: (threadId) => {
          queued.push(`${guild.guildId}:${threadId}`)
          return true
        },
      },
    ]),
  )
  const bot = new DiscordBot(fixture.config, "English", {
    listAutomations: () => [],
    triggerAutomation: (name) => {
      triggers.push(name)
      return "queued"
    },
    chats,
  })
  await Effect.runPromise(bot.startEffect())
  t.after(() => Effect.runPromise(bot.stopEffect()))
  const client = fixture.clients[0]!
  assert.equal(fixture.clients.length, 1)
  assert.equal(fixture.login.mock.callCount(), 1)
  assert.deepEqual(fixture.commands, ["100", "200"])
  assert.deepEqual(fixture.channels, ["1001", "1002", "2001", "2002"])
  assert.equal(
    client.options.intents.bitfield,
    GatewayIntentBits.Guilds |
      GatewayIntentBits.GuildMessages |
      GatewayIntentBits.MessageContent,
  )
  assert.deepEqual(client.options.allowedMentions, { parse: [] })

  const replies: string[] = []
  const command = (guildId: string, role: string, administrator = false) => ({
    isChatInputCommand: () => true,
    commandName: "automation",
    guildId,
    user: { tag: "operator" },
    memberPermissions: { has: () => administrator },
    member: { roles: [role] },
    options: {
      getSubcommand: () => "run",
      getString: () => `task-${guildId}`,
    },
    reply: async (reply: { content: string }) => {
      replies.push(reply.content)
    },
  })
  await dispatch(client, Events.InteractionCreate, command("100", "1003"))
  await dispatch(client, Events.InteractionCreate, command("200", "2003"))
  await dispatch(client, Events.InteractionCreate, command("200", "1003"))
  await dispatch(client, Events.InteractionCreate, command("300", "", true))
  assert.deepEqual(triggers, ["task-100", "task-200"])
  assert.equal(replies.length, 3)
  assert.equal(replies[2], "Not authorized.")

  const message = (guildId: string, channelId: string) => ({
    id: "message",
    guildId,
    channelId,
    inGuild: () => true,
    author: { bot: false },
    webhookId: null,
    content: "Please investigate playback",
    channel: {
      type: ChannelType.GuildText,
      isThread: () => false,
    },
  })
  await dispatch(client, Events.MessageCreate, message("100", "1002"))
  await dispatch(client, Events.MessageCreate, message("200", "2002"))
  await dispatch(client, Events.MessageCreate, message("200", "1002"))
  await dispatch(client, Events.MessageCreate, message("300", "3002"))
  assert.deepEqual(triaged, ["100", "200"])
  for (const guildId of ["100", "200"]) {
    await dispatch(client, Events.MessageCreate, {
      ...message(guildId, `${guildId}5`),
      channel: {
        id: `${guildId}5`,
        type: ChannelType.PrivateThread,
        isThread: () => true,
        parentId: `${guildId}2`,
        ownerId: "999",
        name: "blitzcrank: playback",
        send: async () => ({ edit: async () => undefined }),
      },
    })
  }
  assert.deepEqual(queued, ["100:1005", "200:2005"])

  fixture.reportFailures.add("100")
  await Effect.runPromise(
    bot.reportEffect({
      name: "test",
      status: "ok",
      body: "done",
      reads: 0,
      mutations: 0,
      deletes: 0,
      tokens: 0,
      malformed: false,
      empty: false,
    }),
  )
  assert.deepEqual(fixture.reports, ["200"])
  assert.equal(fixture.stop.mock.callCount(), 0)
  t.after(() => assert.equal(fixture.stop.mock.callCount(), 1))
})

test("report-only guilds share one client with no intents or message handler", async (t) => {
  const fixture = discordFixture(t, false)
  const bot = new DiscordBot(fixture.config, "English", {
    listAutomations: () => [],
    triggerAutomation: () => "queued",
    chats: new Map(),
  })
  await Effect.runPromise(bot.startEffect())
  t.after(() => Effect.runPromise(bot.stopEffect()))
  assert.equal(fixture.clients.length, 1)
  const client = fixture.clients[0]!
  assert.equal(client.options.intents.bitfield, 0)
  assert.equal(client.listenerCount(Events.MessageCreate), 0)
  assert.equal(client.listenerCount(Events.InteractionCreate), 1)
  assert.deepEqual(fixture.commands, ["100", "200"])
})

test("invalid second guild never admits handlers and keeps the client available for shutdown", async (t) => {
  const fixture = discordFixture(t, false)
  fixture.invalidChannels.add("2001")
  const bot = new DiscordBot(fixture.config, "English", {
    listAutomations: () => [],
    triggerAutomation: () => "queued",
    chats: new Map(),
  })
  await assert.rejects(
    Effect.runPromise(bot.startEffect()),
    /not a text channel/,
  )
  assert.equal(fixture.clients.length, 1)
  assert.equal(fixture.stop.mock.callCount(), 0)
  assert.equal(fixture.clients[0]!.listenerCount(Events.InteractionCreate), 0)
  assert.equal(fixture.clients[0]!.listenerCount(Events.MessageCreate), 0)
  await Effect.runPromise(bot.stopEffect())
  assert.equal(fixture.stop.mock.callCount(), 1)
})

test("Discord thread storage keeps existing sessions and rejects unsafe IDs", () => {
  assert.equal(
    conversationSessionDir("/data", "123"),
    "/data/sessions/discord/123",
  )
  assert.throws(() => conversationSessionDir("/data", "../123"))
})
