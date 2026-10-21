import { Cause, Effect } from "effect"

import { threadKey, type Intake, type ThreadRef } from "../../gateway.ts"
import { errorKind, logEvent } from "../../log.ts"
import { mentionsBot, messageText, threadName } from "../chat.ts"
import { TriageError, type Triage } from "../triage.ts"
import { FluxerError, type FluxerClient } from "./client.ts"
import type { FluxerConfig } from "./config.ts"
import {
  ChannelType,
  MessageType,
  type Channel,
  type MessageCreate,
} from "./types.ts"

export const NAME = "fluxer"

/** What recovery needs to check a message's sender again. */
export interface FluxerSource {
  guild: string
  /** The watched channel the thread hangs off. */
  parent: string
  author: string
}

export type Allowlist = Pick<FluxerConfig, "users" | "roles">

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
  fluxer: FluxerClient,
  config: Allowlist,
  guild: string,
  author: string,
): Effect.Effect<boolean, FluxerError> {
  return fluxer
    .memberEffect(guild, author)
    .pipe(
      Effect.map(
        (member) =>
          member !== undefined && allowed(config, author, member.roles),
      ),
    )
}

type Place = { kind: "channel" } | { kind: "thread"; parent: string }

const THREAD_TYPES: ReadonlySet<number> = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
])

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
    private readonly fluxer: FluxerClient,
    private readonly watched: ReadonlySet<string>,
    private readonly botId: string,
  ) {}

  /** Fluxer sends every message's channel type, so only a thread costs a lookup. */
  placeEffect(
    channelId: string,
    channelType: number,
  ): Effect.Effect<Place | undefined, FluxerError> {
    if (this.watched.has(channelId)) return Effect.succeed({ kind: "channel" })
    if (!THREAD_TYPES.has(channelType)) return Effect.succeed(undefined)
    const known = this.threads.get(channelId)
    if (known !== undefined) return Effect.succeed(threadPlace(known))
    return this.fluxer.channelEffect(channelId).pipe(
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

  private botThreadParent(channel: Channel): string | undefined {
    if (!THREAD_TYPES.has(channel.type)) return undefined
    if (channel.owner_id !== this.botId || !channel.parent_id) return undefined
    return this.watched.has(channel.parent_id) ? channel.parent_id : undefined
  }
}

function threadPlace(parent: string | null): Place | undefined {
  return parent === null ? undefined : { kind: "thread", parent }
}

export interface AdmissionDeps {
  config: FluxerConfig
  fluxer: FluxerClient
  places: Places
  triage: Triage
  intake: Intake
  botId: string
  /** The fixed line a turned-away mention gets. */
  denial: string
}

/**
 * One Fluxer message, from arrival to a submitted event, a denial, or
 * nothing. The sender is checked before triage, so a stranger costs no model
 * call. Triage only decides; what the bot posts is the run's reply or the
 * fixed denial line.
 */
export function admitEffect(
  message: MessageCreate,
  deps: AdmissionDeps,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    // The socket opens before recovery. Until the host is ready, a message
    // only waits here, where closing the listener can still interrupt it.
    yield* deps.intake.opened
    if (message.author.bot || typeof message.webhook_id === "string") return
    if (
      message.type !== MessageType.Default &&
      message.type !== MessageType.Reply
    )
      return
    const guild = message.guild_id
    if (guild === undefined) return
    const place = yield* deps.places.placeEffect(
      message.channel_id,
      message.channel_type,
    )
    if (place === undefined) return
    // A thread started from a message shares that message's id. Fluxer can
    // echo the starter into the thread; it is not a follow-up.
    if (place.kind === "thread" && message.id === message.channel_id) return

    const mentioned = mentionsBot(message.content, deps.botId)
    // Fluxer attaches the author's member from its guild state. Should that
    // ever be missing, a live lookup decides, not a refusal.
    const permitted = message.member
      ? allowed(deps.config, message.author.id, message.member.roles)
      : yield* memberAllowedEffect(
          deps.fluxer,
          deps.config,
          guild,
          message.author.id,
        )
    if (!permitted) {
      // Unlisted chatter in a watched channel is the normal case, not news.
      if (mentioned || place.kind === "thread")
        logEvent(
          "fluxer.denied",
          { reason: "not_allowed", in: place.kind },
          "warn",
        )
      return
    }
    const text = messageText(message.content, message.mentions, deps.botId)
    if (!text) return

    if (place.kind === "thread") {
      yield* deps.intake.submit({
        thread: { gateway: NAME, id: message.channel_id },
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
      gateway: NAME,
      label: verdict.label,
      stack: Math.round(verdict.stack * 100) / 100,
      mentioned,
      accepted,
    })
    if (accepted) {
      yield* openEffect(message, text, guild, deps)
      return
    }
    // Fluxer has no `fail_if_not_exists`. A message deleted since fails the
    // reply with a 404, and the denial then has nothing left to answer.
    if (mentioned)
      yield* deps.fluxer.postEffect(message.channel_id, deps.denial, message.id)
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      logEvent(
        "fluxer.admission_failed",
        failureFields(Cause.squash(cause)),
        "warn",
      )
      return Effect.void
    }),
  )
}

/** Kinds and codes only: provider and Fluxer messages can echo the text. */
function failureFields(error: unknown) {
  if (error instanceof TriageError)
    return { error: "triage", reason: error.reason }
  if (error instanceof FluxerError)
    return { error: "fluxer", status: error.status, code: error.code }
  return { error: errorKind(error) }
}

/**
 * The thread and its job come into being together: a shutdown that stops
 * listening waits for both, so no thread is left without its run.
 */
function openEffect(
  message: MessageCreate,
  text: string,
  guild: string,
  deps: AdmissionDeps,
) {
  return Effect.gen(function* () {
    const name = threadName(text)
    const opened = yield* deps.fluxer.startThreadEffect(
      message.channel_id,
      message.id,
      name,
    )
    deps.places.remember(opened.id, message.channel_id)
    const thread: ThreadRef = { gateway: NAME, id: opened.id }
    const result = yield* deps.intake.submit({
      thread,
      type: "MESSAGE_CREATE",
      reply: false,
      title: name,
      text,
      source: {
        guild,
        parent: message.channel_id,
        author: message.author.id,
      },
    })
    logEvent("fluxer.thread_opened", { thread: threadKey(thread), result })
  }).pipe(Effect.uninterruptible)
}
