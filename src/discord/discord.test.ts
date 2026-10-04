import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  ChannelType,
  type Message,
  type MessageCreateOptions,
} from "discord.js"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { SdkError } from "../agent/effect.ts"
import type { Config } from "../config.ts"
import { RunContext } from "../tools/context.ts"
import {
  buildDiscordAnswerTools,
  buildDiscordTools,
  buildServiceTools,
  type SessionFileRef,
} from "../tools/index.ts"
import type { DiscordReplyDelivery, DiscordReplyRequest } from "./agent.ts"
import {
  conversationThreadName,
  DiscordBot,
  discordMessageChunks,
  type DiscordDeps,
} from "./bot.ts"
import { DiscordConversations } from "./conversations.ts"
import {
  DISCORD_TRIAGE_TOOL,
  parseDiscordTriage,
  type DiscordTriageCapture,
} from "./triage.ts"
import { withTypingEffect } from "./typing.ts"

test("triage accepts one final typed submission", () => {
  const capture: DiscordTriageCapture = {
    submissions: [
      {
        route: "thread",
        threadName: "Playback problem",
      },
    ],
  }

  assert.deepEqual(parseDiscordTriage(capture, [DISCORD_TRIAGE_TOOL]), {
    route: "thread",
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

  assert.deepEqual(
    buildDiscordAnswerTools(config, new RunContext()).map((tool) => tool.name),
    ["seerr_request", "sonarr_request", "radarr_request", "jellyfin_request"],
  )
})

test("triage fails closed for missing, duplicate, or untitled thread decisions", () => {
  assert.equal(
    parseDiscordTriage({ submissions: [] }, [DISCORD_TRIAGE_TOOL]),
    undefined,
  )
  assert.equal(
    parseDiscordTriage(
      {
        submissions: [
          { route: "answer", threadName: "" },
          { route: "thread", threadName: "Dune: no audio" },
        ],
      },
      [DISCORD_TRIAGE_TOOL],
    ),
    undefined,
  )
  assert.equal(
    parseDiscordTriage(
      { submissions: [{ route: "thread", threadName: "  " }] },
      [DISCORD_TRIAGE_TOOL],
    ),
    undefined,
  )
  assert.deepEqual(
    parseDiscordTriage({ submissions: [{ route: "answer", threadName: "" }] }, [
      DISCORD_TRIAGE_TOOL,
    ]),
    { route: "answer", threadName: "" },
  )
})

test("conversation titles are natural, bounded, and keep Unicode intact", () => {
  assert.equal(
    conversationThreadName(
      'blitzcrank: "Die Tagebücher der Apothekerin: Folge fehlt"',
    ),
    "Die Tagebücher der Apothekerin: Folge fehlt",
  )
  assert.equal(
    conversationThreadName("  Dune:\n kein\u200b Ton  "),
    "Dune: kein Ton",
  )
  assert.equal(conversationThreadName("  ", "Deutsch"), "Medienproblem")
  assert.equal(conversationThreadName(""), "Media help")
  const title = conversationThreadName(`${"a".repeat(98)}😀${"b".repeat(20)}`)
  assert.ok(title.length <= 100)
  assert.equal(Buffer.from(title).toString("utf8"), title)
  assert.ok(title.endsWith("…"))
})

test("typing refreshes during work and stops on success, failure, or interruption", async () => {
  for (const outcome of ["success", "failure", "interruption"] as const) {
    let ticks = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const release = Deferred.makeUnsafe<void>()
        const task = yield* withTypingEffect(
          Deferred.await(release).pipe(
            Effect.andThen(() =>
              outcome === "failure"
                ? Effect.fail(new Error("run failed"))
                : Effect.void,
            ),
          ),
          () =>
            Effect.sync(() => {
              ticks += 1
            }),
        ).pipe(Effect.forkChild)
        yield* TestClock.adjust("12 seconds")
        assert.equal(ticks, 3)
        if (outcome === "interruption") yield* Fiber.interrupt(task)
        if (outcome !== "interruption")
          yield* Deferred.succeed(release, undefined)
        yield* Fiber.await(task)
        yield* TestClock.adjust("20 seconds")
        assert.equal(ticks, 3)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  }
})

test("typing errors and stalled requests cannot fail or delay an answer", async () => {
  for (const typing of [
    () => Effect.fail(new Error("Discord unavailable")),
    () => Effect.never,
  ]) {
    const answer = await Effect.runPromise(
      withTypingEffect(
        Effect.sleep("1 second").pipe(Effect.as("answer")),
        typing,
      ).pipe(
        Effect.forkChild,
        Effect.flatMap((fiber) =>
          TestClock.adjust("1 second").pipe(Effect.andThen(Fiber.join(fiber))),
        ),
        Effect.provide(TestClock.layer()),
      ),
    )
    assert.equal(answer, "answer")
  }
})

async function botHarness(
  t: test.TestContext,
  route: "answer" | "thread" | "ignore",
) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-discord-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const sent: MessageCreateOptions[] = []
  const threadSent: MessageCreateOptions[] = []
  const created: { name: string; type: ChannelType; invitable: boolean }[] = []
  const members: string[] = []
  const requests: DiscordReplyRequest[] = []
  const deliveries: DiscordReplyDelivery[] = []
  const classified: string[] = []
  const conversations = new DiscordConversations(dataDir)
  const thread = {
    id: "300",
    type: ChannelType.PrivateThread,
    parentId: "200",
    ownerId: "999",
    name: "Die Tagebücher der Apothekerin: Folge fehlt",
    isThread: () => true,
    members: {
      add: async (id: string) => {
        members.push(id)
      },
    },
    send: async (options: MessageCreateOptions) => {
      threadSent.push(options)
    },
    sendTyping: () => Promise.resolve(),
  }
  const channel = {
    id: "200",
    type: ChannelType.GuildText,
    isThread: () => false,
    threads: {
      create: async (options: (typeof created)[number]) => {
        created.push(options)
        return thread
      },
    },
    send: async (options: MessageCreateOptions) => {
      sent.push(options)
    },
    sendTyping: () => Promise.resolve(),
  }
  const chat: NonNullable<DiscordDeps["chat"]> = {
    triageEffect: (_id, content) => {
      classified.push(content)
      return Effect.succeed({
        route,
        threadName: route === "thread" ? thread.name : "",
      })
    },
    enqueue: (request, delivery) => {
      requests.push(request)
      deliveries.push(delivery)
      return true
    },
  }
  // SDK-shaped test doubles; no gateway connection or Discord writes.
  const bot = Reflect.construct(DiscordBot, [
    { user: { id: "999" } },
    { guildId: "100", inboxChannelId: "200" },
    "Deutsch",
    undefined,
    { chat },
    conversations,
  ]) as DiscordBot
  const message = {
    id: "400",
    guildId: "100",
    channelId: "200",
    channel,
    content: "Wann kommt die neue Staffel von Die Tagebücher der Apothekerin?",
    author: { id: "500", tag: "zekurio", bot: false },
    webhookId: null,
    inGuild: () => true,
    url: "https://discord.com/channels/100/200/400",
    mentions: { users: new Map([["999", {}]]) },
    reply: channel.send,
  }
  return {
    bot,
    chat,
    message,
    thread,
    sent,
    threadSent,
    created,
    members,
    requests,
    deliveries,
    classified,
    conversations,
    dataDir,
    receive: (value: object = message) =>
      Effect.runPromise(bot["onMessageEffect"](value as Message<true>)),
  }
}

test("quick questions get a referenced channel answer without a placeholder or thread", async (t) => {
  const h = await botHarness(t, "answer")
  await h.receive()
  assert.deepEqual(h.created, [])
  assert.equal(h.sent.length, 0)
  assert.equal(h.requests[0]?.route, "answer")
  await Effect.runPromise(
    h.deliveries[0]!.send("Die neue Staffel startet am Freitag."),
  )
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.sent[0]?.reply, {
    messageReference: "400",
    failIfNotExists: false,
  })
  assert.deepEqual(h.sent[0]?.allowedMentions, {
    parse: [],
    repliedUser: false,
  })
})

test("troubleshooting creates a named private conversation that survives renames and restarts", async (t) => {
  const h = await botHarness(t, "thread")
  await h.receive()
  assert.deepEqual(
    h.created.map((options) => [options.name, options.type, options.invitable]),
    [
      [
        "Die Tagebücher der Apothekerin: Folge fehlt",
        ChannelType.PrivateThread,
        false,
      ],
    ],
  )
  assert.deepEqual(h.members, ["500"])
  assert.equal(h.threadSent.length, 1)
  assert.deepEqual(h.threadSent[0]?.embeds, [
    {
      author: { name: "zekurio" },
      title: "Zur Nachricht",
      url: h.message.url,
      description: h.message.content,
    },
  ])
  assert.equal(h.requests[0]?.route, "thread")
  assert.equal(
    await Effect.runPromise(
      new DiscordConversations(h.dataDir).hasEffect("300"),
    ),
    true,
  )
  h.thread.name = "Folge 3 fehlt"
  await h.receive({
    ...h.message,
    channelId: "300",
    channel: h.thread,
    content: "Nur Folge 3.",
  })
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1]?.id, "300")
})

test("legacy conversations are adopted while other threads and untrusted senders are ignored", async (t) => {
  const h = await botHarness(t, "answer")
  const reply = { ...h.message, channelId: "300", channel: h.thread }
  await h.receive(reply)
  assert.deepEqual(h.requests, [])
  h.thread.name = "blitzcrank: Old conversation"
  await h.receive(reply)
  assert.equal(h.requests.length, 1)
  assert.equal(await Effect.runPromise(h.conversations.hasEffect("300")), true)
  for (const changes of [
    { guildId: "101" },
    { author: { ...h.message.author, bot: true } },
    { webhookId: "600" },
    { content: " " },
    { channel: { ...h.thread, ownerId: "998" } },
    { channel: { ...h.thread, parentId: "201" } },
    { channel: { ...h.thread, type: ChannelType.PublicThread } },
  ])
    await h.receive({ ...reply, ...changes })
  assert.equal(h.requests.length, 1)
})

test("ignored messages stay quiet and a closed queue produces one plain failure reply", async (t) => {
  const h = await botHarness(t, "ignore")
  await h.receive()
  assert.deepEqual(h.requests, [])
  assert.deepEqual(h.created, [])
  assert.equal(h.sent.length, 0)
  h.chat.triageEffect = () =>
    Effect.succeed({ route: "answer", threadName: "" })
  h.chat.enqueue = () => false
  await h.receive()
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0]!.content!, /Versuch es bitte noch einmal/)
})

test("public follow-ups quote only this bot's answer in the same channel", async (t) => {
  const h = await botHarness(t, "answer")
  const previous = {
    author: { id: "999" },
    channelId: "200",
    webhookId: null,
    content: "Die Tagebücher der Apothekerin Staffel 3 startet am Freitag.",
  }
  const reply = {
    ...h.message,
    content: "Und auf Deutsch?",
    reference: { channelId: "200", messageId: "401" },
    fetchReference: () => Promise.resolve(previous),
  }
  await h.receive(reply)
  assert.match(h.classified[0]!, /Die Tagebücher der Apothekerin Staffel 3/)
  assert.match(h.requests[0]!.content, /Und auf Deutsch/)
  await h.receive({
    ...reply,
    reference: { channelId: "300", messageId: "401" },
  })
  assert.equal(h.classified[1], "Und auf Deutsch?")
  previous.author.id = "500"
  await h.receive(reply)
  assert.equal(h.classified[2], "Und auf Deutsch?")
  await h.receive({
    ...reply,
    fetchReference: () => Promise.reject(new Error("deleted")),
  })
  assert.equal(h.classified[3], "Und auf Deutsch?")
})

test("triage and thread setup failures notify the requester without enqueueing a run", async (t) => {
  const triage = await botHarness(t, "answer")
  triage.chat.triageEffect = () =>
    Effect.fail(
      new SdkError({
        message: "invalid triage result",
        cause: undefined,
      }),
    )
  await assert.rejects(triage.receive(), /invalid triage result/)
  assert.equal(triage.sent.length, 1)
  assert.equal(triage.requests.length, 0)

  // Failed classification of ambient chat must remain silent.
  await assert.rejects(
    triage.receive({ ...triage.message, mentions: { users: new Map() } }),
    /invalid triage result/,
  )
  assert.equal(triage.sent.length, 1)

  const thread = await botHarness(t, "thread")
  thread.thread.members.add = () =>
    Promise.reject(new Error("missing permission"))
  await assert.rejects(thread.receive(), /missing permission/)
  assert.equal(thread.sent.length, 1)
  assert.equal(thread.threadSent.length, 0)
  assert.equal(thread.requests.length, 0)
})

test("conversation registration tolerates simultaneous legacy replies and rejects invalid IDs", async (t) => {
  const h = await botHarness(t, "answer")
  await Promise.all([
    Effect.runPromise(h.conversations.registerEffect("300")),
    Effect.runPromise(h.conversations.registerEffect("300")),
  ])
  assert.equal(await Effect.runPromise(h.conversations.hasEffect("300")), true)
  assert.equal(await Effect.runPromise(h.conversations.hasEffect("301")), false)
  await assert.rejects(
    Effect.runPromise(h.conversations.registerEffect("../300")),
    /invalid Discord thread id/,
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
