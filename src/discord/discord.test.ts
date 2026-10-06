import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import {
  ChannelType,
  type Message,
  type MessageCreateOptions,
} from "discord.js"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { SdkError } from "../agent/effect.ts"
import type { AgentTurnOptions, AgentTurnResult } from "../agent/session.ts"
import type { Config } from "../config.ts"
import { EvidenceStore } from "../evidence.ts"
import { JobStore } from "../jobs.ts"
import { SerialQueue } from "../queue.ts"
import { RunContext } from "../tools/context.ts"
import {
  buildDiscordAnswerTools,
  buildDiscordTools,
  buildServiceTools,
  type SessionFileRef,
} from "../tools/index.ts"
import {
  DiscordAgent,
  discordSystemPrompt,
  type DiscordReplyDelivery,
  type DiscordReplyJob,
  type DiscordReplyRequest,
} from "./agent.ts"
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
  const permissions = { allowed: true, member: true }
  const conversations = new DiscordConversations(dataDir)
  const thread = {
    id: "300",
    type: ChannelType.PrivateThread,
    parentId: "200",
    ownerId: "999",
    name: "Die Tagebücher der Apothekerin: Folge fehlt",
    isThread: () => true,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => permissions.allowed }),
    members: {
      fetch: async () => {
        if (!permissions.member) throw new Error("membership revoked")
        return {}
      },
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
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => permissions.allowed }),
    messages: {
      fetch: async () => ({ author: { id: "500", bot: false } }),
    },
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
    restoreEffect: () => Effect.void,
    hasAccepted: () => false,
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
    {
      user: { id: "999" },
      guilds: {
        fetch: async () => ({
          channels: {
            fetch: async (id: string) =>
              id === channel.id ? channel : id === thread.id ? thread : null,
          },
          members: { fetch: async (id: string) => ({ id }) },
        }),
      },
    },
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
    permissions,
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

class AdmissionQueue extends SerialQueue {
  readonly tasks: (() => Effect.Effect<void, unknown>)[] = []

  override enqueueEffect(task: () => Effect.Effect<void, unknown>): void {
    this.tasks.push(task)
  }
}

function journalAgent(dataDir: string, queue: SerialQueue, jobs: JobStore) {
  return new DiscordAgent(
    { dataDir } as Config,
    {} as ModelRuntime,
    "fake",
    "fake",
    queue,
    jobs,
  )
}

const journalRequest: DiscordReplyRequest = {
  route: "answer",
  id: "400",
  content: "Is Dune available?",
  channelId: "200",
  guildId: "100",
  sourceMessageId: "400",
  sourceChannelId: "200",
  userId: "500",
  replyTo: "400",
}

test("reply admission persists content and scope before returning and deduplicates source IDs", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "discord-jobs-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const file = path.join(dataDir, "jobs.sqlite")
  const jobs = new JobStore(file)
  const queue = new AdmissionQueue()
  const agent = journalAgent(dataDir, queue, jobs)
  const delivery: DiscordReplyDelivery = {
    typing: () => Effect.void,
    send: () => Effect.void,
    fail: () => Effect.void,
  }
  assert.equal(agent.enqueue(journalRequest, delivery), true)
  assert.equal(agent.enqueue(journalRequest, delivery), true)
  assert.equal(queue.tasks.length, 1)
  jobs.close()

  const restored = new JobStore(file)
  t.after(() => restored.close())
  const payload = restored.get("discord:400")!.payload as DiscordReplyJob
  assert.deepEqual(
    { ...payload, timestamp: undefined },
    { ...journalRequest, timestamp: undefined },
  )
  assert.match(
    discordSystemPrompt(
      "English",
      { search: undefined, extract: undefined },
      "answer",
      payload.timestamp,
    ),
    new RegExp(payload.timestamp),
  )
  const recoveredQueue = new AdmissionQueue()
  const recovered = journalAgent(dataDir, recoveredQueue, restored)
  const observed: DiscordReplyJob[] = []
  recovered["respondEffect"] = (request) => {
    observed.push(request)
    return Effect.succeed("Available.")
  }
  let posts = 0
  await Effect.runPromise(
    recovered.restoreEffect((request) => {
      assert.deepEqual(request, payload)
      return Effect.succeed({
        ...delivery,
        send: () => Effect.sync(() => void (posts += 1)),
      })
    }),
  )
  await Effect.runPromise(recoveredQueue.tasks[0]!())
  assert.deepEqual(observed, [payload])
  assert.equal(posts, 1)
  assert.equal(restored.get("discord:400")!.status, "completed")
  assert.equal(recovered.enqueue(journalRequest, delivery), true)
  assert.equal(recoveredQueue.tasks.length, 1)
})

test("uncertain reply publication fails closed without a model run or contradictory failure post", async (t) => {
  for (const completed of [false, true]) {
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "discord-publication-"),
    )
    t.after(() => rm(dataDir, { recursive: true, force: true }))
    const file = path.join(dataDir, "jobs.sqlite")
    const jobs = new JobStore(file)
    jobs.create(
      "discord",
      { ...journalRequest, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "discord:400" },
    )
    await Effect.runPromiseExit(
      jobs.actionEffect(
        "discord:400",
        "publication",
        completed
          ? Effect.succeed({ kind: "reply" })
          : Effect.fail(new Error("lost Discord acknowledgement")),
      ),
    )
    jobs.close()
    const restored = new JobStore(file)
    t.after(() => restored.close())
    const queue = new AdmissionQueue()
    const agent = journalAgent(dataDir, queue, restored)
    agent["respondEffect"] = () => {
      assert.fail("a publication intent must bypass the model")
    }
    let posts = 0
    await Effect.runPromise(
      agent.restoreEffect(() =>
        Effect.succeed({
          typing: () => Effect.void,
          send: () => Effect.sync(() => void (posts += 1)),
          fail: () => Effect.sync(() => void (posts += 1)),
        }),
      ),
    )
    const exit = await Effect.runPromiseExit(queue.tasks[0]!())
    assert.equal(exit._tag, completed ? "Success" : "Failure")
    assert.equal(posts, 0)
    assert.equal(
      restored.get("discord:400")!.status,
      completed ? "completed" : "failed",
    )
  }
})

test("revoked recovery authorization persists failure without enqueueing or publishing", async () => {
  const jobs = new JobStore()
  const queue = new AdmissionQueue()
  const agent = journalAgent("/tmp/unused", queue, jobs)
  jobs.create(
    "discord",
    { ...journalRequest, timestamp: "2026-01-01T00:00:00.000Z" },
    { id: "discord:400" },
  )
  await Effect.runPromise(
    agent.restoreEffect(() => Effect.fail(new Error("membership revoked"))),
  )
  assert.equal(queue.tasks.length, 0)
  assert.equal(jobs.get("discord:400")!.status, "failed")
  assert.match(jobs.get("discord:400")!.error!, /membership revoked/)
  jobs.close()
})

test("recovery fetches authorized channels and rejects changed guild, inbox, ownership, or permissions", async (t) => {
  const inline = await botHarness(t, "answer")
  await inline.receive()
  const request: DiscordReplyJob = {
    ...inline.requests[0]!,
    timestamp: "2026-01-01T00:00:00.000Z",
  }
  const delivery = await Effect.runPromise(
    inline.bot["restoreDeliveryEffect"](request),
  )
  await Effect.runPromise(delivery.send("Available."))
  assert.equal(inline.sent.length, 1)
  assert.deepEqual(inline.sent[0]!.allowedMentions, {
    parse: [],
    repliedUser: false,
  })
  for (const rejected of [
    { ...request, guildId: "other" },
    { ...request, channelId: "300" },
    { ...request, sourceChannelId: "300" },
  ])
    await assert.rejects(
      Effect.runPromise(inline.bot["restoreDeliveryEffect"](rejected)),
    )
  inline.permissions.allowed = false
  await assert.rejects(
    Effect.runPromise(inline.bot["restoreDeliveryEffect"](request)),
    /permission revoked/,
  )

  const privateThread = await botHarness(t, "thread")
  await privateThread.receive()
  const privateRequest: DiscordReplyJob = {
    ...privateThread.requests[0]!,
    timestamp: request.timestamp,
  }
  await Effect.runPromise(
    privateThread.bot["restoreDeliveryEffect"](privateRequest),
  )
  const threadCount = privateThread.created.length
  privateThread.permissions.member = false
  await assert.rejects(
    Effect.runPromise(
      privateThread.bot["restoreDeliveryEffect"](privateRequest),
    ),
    /membership revoked/,
  )
  privateThread.permissions.member = true
  privateThread.thread.ownerId = "other"
  await assert.rejects(
    Effect.runPromise(
      privateThread.bot["restoreDeliveryEffect"](privateRequest),
    ),
    /scope changed/,
  )
  assert.equal(privateThread.created.length, threadCount)
})

test("repeat gateway events cannot create two conversations concurrently or after acceptance", async (t) => {
  const h = await botHarness(t, "thread")
  await Promise.all([h.receive(), h.receive()])
  assert.equal(h.created.length, 1)
  h.chat.hasAccepted = () => true
  await h.receive()
  assert.equal(h.created.length, 1)
})

const emptyTurn = {
  text: "Available.",
  finalToolNames: [],
  terminalToolResults: [],
  successfulToolCounts: {},
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    newTokens: 0,
    billedTokens: 0,
    costUsd: undefined,
  },
  sessionFile: undefined,
  resumed: false,
}

function runtimeAgent(
  dataDir: string,
  queue: SerialQueue,
  jobs: JobStore,
  result: AgentTurnResult,
  turns: AgentTurnOptions[],
) {
  return new DiscordAgent(
    {
      dataDir,
      language: "English",
      web: { provider: "none" },
      seerr: { url: "http://never-called.test", apiKey: "fake" },
    } as Config,
    { getModel: () => ({ input: ["text"] }) } as unknown as ModelRuntime,
    "fake/model",
    "fake/triage",
    queue,
    jobs,
    (options) => {
      turns.push(options)
      return Effect.succeed(result)
    },
  )
}

test("Durable replies use stable request IDs, isolated inline files, frozen policy time, and carried private evidence", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "discord-runtime-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const jobs = new JobStore()
  t.after(() => jobs.close())
  const queue = new AdmissionQueue()
  const turns: AgentTurnOptions[] = []
  const agent = runtimeAgent(dataDir, queue, jobs, emptyTurn, turns)
  const request: DiscordReplyJob = {
    ...journalRequest,
    timestamp: "2026-01-01T00:00:00.000Z",
  }
  await Effect.runPromise(agent["respondEffect"](request))
  await Effect.runPromise(agent["respondEffect"](request))
  assert.equal(turns[0]!.requestId, "400")
  assert.equal(
    turns[0]!.storageFile,
    path.join(dataDir, "sessions", "inline", "400.sqlite"),
  )
  assert.equal(turns[0]!.systemPrompt, turns[1]!.systemPrompt)
  assert.match(turns[0]!.systemPrompt, /2026-01-01T00:00:00.000Z/)
  assert.deepEqual(
    turns[0]!.tools.map((tool) => tool.name),
    ["seerr_request"],
  )

  const ctx = new RunContext()
  ctx.recordRead("seerr", "/api/v1/request/7", '{"id":7}')
  const evidence = new EvidenceStore(
    path.join(dataDir, "evidence", "discord"),
    "discord",
  )
  await Effect.runPromise(evidence.saveEffect("300", ctx.snapshot))
  await Effect.runPromise(
    agent["respondEffect"]({
      ...request,
      route: "thread",
      id: "300",
      channelId: "300",
    }),
  )
  const privateTurn = turns[2]!
  assert.equal(privateTurn.requestId, "400")
  assert.equal(
    privateTurn.storageFile,
    path.join(dataDir, "sessions", "discord", "300", "conversation.sqlite"),
  )
  assert.deepEqual(
    privateTurn.runContext!.snapshot.evidence,
    ctx.snapshot.evidence,
  )
  assert.equal(turns[0]!.runContext!.snapshot.evidence.length, 0)
  assert.ok(
    privateTurn.tools.some((tool) => tool.name === "thread_history_search"),
  )
  assert.ok(
    privateTurn.tools.some((tool) => tool.name === "seerr_create_request"),
  )
})

test("Durable recovery failures cannot publish stale model text or a contradictory error", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "discord-review-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  for (const kind of [
    "unsafe-interrupted",
    "policy-changed",
    "unanswered",
  ] as const) {
    const jobs = new JobStore()
    const queue = new AdmissionQueue()
    const turns: AgentTurnOptions[] = []
    const agent = runtimeAgent(
      dataDir,
      queue,
      jobs,
      {
        ...emptyTurn,
        text: "Old answer that must not be sent.",
        failure: { kind, message: "operator review required", toolNames: [] },
      },
      turns,
    )
    let posts = 0
    agent.enqueue(journalRequest, {
      typing: () => Effect.void,
      send: () => Effect.sync(() => void (posts += 1)),
      fail: () => Effect.sync(() => void (posts += 1)),
    })
    const exit = await Effect.runPromiseExit(queue.tasks[0]!())
    assert.equal(exit._tag, "Failure")
    assert.equal(posts, 0)
    assert.equal(jobs.get("discord:400")!.status, "failed")
    assert.match(jobs.get("discord:400")!.error!, new RegExp(kind))
    assert.deepEqual(jobs.actions("discord:400"), [])
    jobs.close()
  }
})

test("triage uses committed Durable terminal details without builtin skill read", async () => {
  const turns: AgentTurnOptions[] = []
  const jobs = new JobStore()
  const agent = runtimeAgent(
    "/tmp/unused",
    new AdmissionQueue(),
    jobs,
    {
      ...emptyTurn,
      text: "",
      finalToolNames: [DISCORD_TRIAGE_TOOL],
      terminalToolResults: [
        {
          toolName: DISCORD_TRIAGE_TOOL,
          toolCallId: "triage-1",
          details: { route: "thread", threadName: "Dune: no sound" },
        },
      ],
    },
    turns,
  )
  assert.deepEqual(
    await Effect.runPromise(agent.triageEffect("400", "Dune has no sound")),
    { route: "thread", threadName: "Dune: no sound" },
  )
  assert.equal(turns[0]!.storageFile, undefined)
  assert.equal(turns[0]!.requestId, "400")
  assert.equal(turns[0]!.builtinRead, false)
  assert.deepEqual(
    turns[0]!.tools.map((tool) => tool.name),
    [DISCORD_TRIAGE_TOOL],
  )
  jobs.close()
})
