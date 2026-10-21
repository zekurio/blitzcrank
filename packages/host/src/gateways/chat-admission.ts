import { Cause, Effect } from "effect"

import { threadKey, type Intake, type ThreadRef } from "../gateway.ts"
import { errorKind, logEvent } from "../log.ts"
import {
  mentionsBot,
  messageText,
  threadName,
  type ChatArrival,
  type ChatChannel,
  type ChatClient,
  type ChatConfig,
  type ChatError,
  type ChatPlatform,
} from "./chat.ts"
import { TriageError, type Triage } from "./triage.ts"

/** What recovery needs to check a message's sender again. */
export interface ChatSource {
  guild: string
  /** The watched channel the thread hangs off. */
  parent: string
  author: string
}

export type Allowlist = Pick<ChatConfig, "users" | "roles">

/** Either list admits a member. */
export function allowed(
  config: Allowlist,
  author: string,
  roles: readonly string[],
): boolean {
  return (
    config.users.has(author) || roles.some((role) => config.roles.has(role))
  )
}

/**
 * Whether someone may use the bot now, by a live member lookup. A user id
 * admits only a current member, as a role does. A failed lookup is an error,
 * not a no.
 */
export function memberAllowedEffect(
  client: ChatClient,
  config: Allowlist,
  guild: string,
  author: string,
): Effect.Effect<boolean, ChatError> {
  return client
    .memberEffect(guild, author)
    .pipe(
      Effect.map(
        (member) =>
          member !== undefined && allowed(config, author, member.roles),
      ),
    )
}

type Place = { kind: "channel" } | { kind: "thread"; parent: string }

/** Enough for every thread a homelab guild sees for a long while. */
const MAX_KNOWN_THREADS = 2_000

/**
 * Whether a message was posted in a watched channel or in a thread the bot
 * opened under one. A thread's parent and owner never change, so one REST
 * lookup per thread is enough.
 */
export class Places {
  /** Thread id to its watched parent, or null for any other thread. */
  private readonly threads = new Map<string, string | null>()

  constructor(
    private readonly client: ChatClient,
    private readonly watched: ReadonlySet<string>,
    private readonly botId: string,
  ) {}

  /** Without `inThread`, only a lookup tells a thread from a channel. */
  placeEffect(
    channelId: string,
    inThread: boolean | undefined,
  ): Effect.Effect<Place | undefined, ChatError> {
    if (this.watched.has(channelId)) return Effect.succeed({ kind: "channel" })
    if (inThread === false) return Effect.succeed(undefined)
    const known = this.threads.get(channelId)
    if (known !== undefined) return Effect.succeed(threadPlace(known))
    return this.client.channelEffect(channelId).pipe(
      Effect.map((channel) => {
        const parent = this.botThreadParent(channel) ?? null
        this.remember(channelId, parent)
        return threadPlace(parent)
      }),
    )
  }

  remember(threadId: string, parent: string | null): void {
    const oldest = this.threads.keys().next()
    if (this.threads.size >= MAX_KNOWN_THREADS && !oldest.done)
      this.threads.delete(oldest.value)
    this.threads.set(threadId, parent)
  }

  private botThreadParent(channel: ChatChannel): string | undefined {
    if (!channel.thread) return undefined
    if (channel.ownerId !== this.botId || !channel.parentId) return undefined
    return this.watched.has(channel.parentId) ? channel.parentId : undefined
  }
}

function threadPlace(parent: string | null): Place | undefined {
  return parent === null ? undefined : { kind: "thread", parent }
}

export interface AdmissionDeps {
  platform: ChatPlatform
  config: ChatConfig
  client: ChatClient
  places: Places
  triage: Triage
  intake: Intake
  botId: string
  /** The fixed line a turned-away mention gets. */
  denial: string
}

/**
 * One chat message, from arrival to a submitted event, a denial, or nothing.
 * The sender is checked before triage, so a stranger costs no model call.
 * Triage only decides; what the bot posts is the run's reply or the fixed
 * denial line.
 */
export function admitEffect(
  message: ChatArrival,
  deps: AdmissionDeps,
): Effect.Effect<void> {
  const name = deps.platform.name
  return Effect.gen(function* () {
    // The socket opens before recovery. Until the host is ready, a message
    // only waits here, where closing the listener can still interrupt it.
    yield* deps.intake.opened
    if (message.author.bot || message.webhook) return
    if (message.kind !== "default" && message.kind !== "reply") return
    const guild = message.guildId
    if (guild === undefined) return
    const place = yield* deps.places.placeEffect(
      message.channelId,
      message.inThread,
    )
    if (place === undefined) return
    // A thread started from a message shares that message's id. The
    // platform can echo the starter into the thread; it is not a follow-up.
    if (place.kind === "thread" && message.id === message.channelId) return

    const mentioned = mentionsBot(message.content, deps.botId)
    // The roles the event carries decide. Both platforms attach the author's
    // member to a guild message in their documented shape; a message without
    // one is refused and logged as `no_member`. A live lookup here would cost
    // a REST call for every stranger's chatter in a watched channel. The
    // roles are as old as the event, which a resumed socket may replay late.
    // Past admission the checks are live: recovery asks again, and a run's
    // context keeps only current members' text, so a member who lost the
    // role since reaches a run only through the message that started it.
    const refusal = refusalOf(message, deps.config)
    if (refusal !== undefined) {
      // Unlisted chatter in a watched channel is the normal case, not news.
      if (mentioned || place.kind === "thread")
        logEvent(`${name}.denied`, { reason: refusal, in: place.kind }, "warn")
      return
    }
    const text = messageText(message.content, message.mentions, deps.botId)
    if (!text) return

    if (place.kind === "thread") {
      yield* deps.intake.submit({
        thread: { gateway: name, id: message.channelId },
        type: "MESSAGE_CREATE",
        reply: true,
        title: undefined,
        text,
        source: { guild, parent: place.parent, author: message.author.id },
      })
      return
    }

    const verdict = yield* deps.triage(text)
    const accepted = mentioned
      ? verdict.label === "stack"
      : verdict.stack >= deps.config.triageThreshold
    logEvent("triage.decided", {
      gateway: name,
      label: verdict.label,
      stack: Math.round(verdict.stack * 100) / 100,
      mentioned,
      accepted,
    })
    if (accepted) {
      yield* openEffect(message, text, guild, deps)
      return
    }
    // Fluxer has no `fail_if_not_exists`: a mention deleted since fails the
    // reply with a 404, and the denial then has nothing left to answer.
    if (mentioned)
      yield* deps.client.postEffect(message.channelId, deps.denial, message.id)
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      logEvent(
        `${name}.admission_failed`,
        failureFields(deps.platform, Cause.squash(cause)),
        "warn",
      )
      return Effect.void
    }),
  )
}

/** Why the event's own member refuses its author, or nothing if it admits them. */
function refusalOf(
  message: ChatArrival,
  config: Allowlist,
): "no_member" | "not_allowed" | undefined {
  if (!message.member) return "no_member"
  if (allowed(config, message.author.id, message.member.roles)) return undefined
  return "not_allowed"
}

/** Kinds and codes only: provider and platform messages can echo the text. */
function failureFields(platform: ChatPlatform, error: unknown) {
  if (error instanceof TriageError)
    return { error: "triage", reason: error.reason }
  if (platform.isError(error))
    return { error: platform.name, status: error.status, code: error.code }
  return { error: errorKind(error) }
}

/**
 * The thread and its job come into being together: a shutdown that stops
 * listening waits for both, so no thread is left without its run.
 */
function openEffect(
  message: ChatArrival,
  text: string,
  guild: string,
  deps: AdmissionDeps,
) {
  return Effect.gen(function* () {
    const name = threadName(text)
    const opened = yield* deps.client.startThreadEffect(
      message.channelId,
      message.id,
      name,
    )
    deps.places.remember(opened.id, message.channelId)
    const thread: ThreadRef = { gateway: deps.platform.name, id: opened.id }
    const result = yield* deps.intake.submit({
      thread,
      type: "MESSAGE_CREATE",
      reply: false,
      title: name,
      text,
      source: {
        guild,
        parent: message.channelId,
        author: message.author.id,
      },
    })
    logEvent(`${deps.platform.name}.thread_opened`, {
      thread: threadKey(thread),
      result,
    })
  }).pipe(Effect.uninterruptible)
}
