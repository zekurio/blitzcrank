import { Cause, Effect } from "effect"

import {
  threadKey,
  type Access,
  type Intake,
  type ThreadRef,
} from "../gateway.ts"
import type { Helper } from "../helper.ts"
import { errorKind, logEvent } from "../log.ts"
import { threadNameEffect } from "./chat-title.ts"
import {
  mentionsBot,
  messageText,
  type ChatArrival,
  type ChatChannel,
  type ChatClient,
  type ChatConfig,
  type ChatError,
  type ChatPlatform,
} from "./chat.ts"
import type { Triage } from "./triage.ts"

/** What recovery needs to check a message's sender again. */
export interface ChatSource {
  guild: string
  /** The watched channel the thread hangs off. */
  parent: string
  author: string
}

export type Allowlist = Pick<
  ChatConfig,
  "users" | "roles" | "adminUsers" | "adminRoles"
>

/**
 * Either admin list makes an admin, who needs no other list. Either of the
 * others admits a member.
 */
export function accessOf(
  config: Allowlist,
  author: string,
  roles: readonly string[],
): Access {
  if (listed(config.adminUsers, config.adminRoles, author, roles))
    return "admin"
  if (listed(config.users, config.roles, author, roles)) return "member"
  return "denied"
}

function listed(
  users: ReadonlySet<string>,
  roles: ReadonlySet<string>,
  author: string,
  memberRoles: readonly string[],
): boolean {
  return users.has(author) || memberRoles.some((role) => roles.has(role))
}

/**
 * What someone may do with the bot now, by a live member lookup. A user id
 * admits only a current member, as a role does. A failed lookup is an error,
 * not a denial.
 */
export function memberAccessEffect(
  client: ChatClient,
  config: Allowlist,
  guild: string,
  author: string,
): Effect.Effect<Access, ChatError> {
  return client
    .memberEffect(guild, author)
    .pipe(
      Effect.map((member) =>
        member === undefined
          ? "denied"
          : accessOf(config, author, member.roles),
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
  /** Names the threads admission opens. */
  helper: Helper
  intake: Intake
  botId: string
  /** The fixed line a turned-away mention gets. */
  denial: string
}

/**
 * One chat message, from arrival to a submitted event, a denial, or nothing.
 * The sender is checked before triage, so a stranger costs no model call.
 * Triage only decides, and the helper only names the thread an accepted
 * message opens; what the bot posts is the run's reply or the fixed denial
 * line.
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

    // A reply to the bot, such as to its denial, carries no mention in its
    // text and still addresses the bot.
    const mentioned =
      mentionsBot(message.content, deps.botId) ||
      message.referenced?.author.id === deps.botId
    // The roles the event carries decide, admin status included. Both
    // platforms attach the author's member to a guild message in their
    // documented shape; a message without one is refused and logged as
    // `no_member`. A live lookup here would cost a REST call for every
    // stranger's chatter in a watched channel. The roles are as old as the
    // event, which a resumed socket may replay late. Past admission the
    // checks are live: recovery asks again, and a run's context keeps only
    // current members' text, so a member who lost the role since reaches a
    // run only through the message that started it.
    const admission = admissionOf(message, deps.config)
    if (admission === "no_member" || admission === "not_allowed") {
      // Unlisted chatter in a watched channel is the normal case, not news.
      if (mentioned || place.kind === "thread")
        logEvent(
          `${name}.denied`,
          { reason: admission, in: place.kind },
          "warn",
        )
      return
    }
    const admin = admission === "admin"
    const text = messageText(message.content, message.mentions, deps.botId)
    // A bare mention or an image alone leaves nothing to triage or answer.
    if (!text) {
      logEvent(`${name}.message_skipped`, {
        reason: "no_text",
        message: message.id,
        in: place.kind,
        mentioned,
      })
      return
    }

    if (place.kind === "thread") {
      yield* deps.intake.submit({
        thread: { gateway: name, id: message.channelId },
        type: "MESSAGE_CREATE",
        reply: true,
        title: undefined,
        text,
        admin,
        source: { guild, parent: place.parent, author: message.author.id },
      })
      return
    }

    const accepted = yield* acceptedEffect(message, text, mentioned, deps)
    if (accepted) {
      const name = yield* threadNameEffect(deps.helper, deps.platform, text)
      yield* openEffect(message, text, name, guild, admin, deps)
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

/**
 * Whether triage lets a channel message open a thread. A mention asks for the
 * bot, so a mentioned message triage cannot judge opens one anyway; an
 * unmentioned one stays quiet. The log carries the message id, so a reported
 * miss can be found in the channel and its scores read here.
 */
function acceptedEffect(
  message: ChatArrival,
  text: string,
  mentioned: boolean,
  deps: AdmissionDeps,
): Effect.Effect<boolean> {
  const fields = {
    gateway: deps.platform.name,
    message: message.id,
    kind: message.kind,
    chars: text.length,
    mentioned,
  }
  return deps.triage(text).pipe(
    Effect.map((verdict) => {
      const accepted = mentioned
        ? verdict.label === "stack"
        : verdict.stack >= deps.config.triageThreshold
      logEvent("triage.decided", {
        ...fields,
        label: verdict.label,
        stack: rounded(verdict.stack),
        chat: rounded(verdict.chat),
        other: rounded(verdict.other),
        confidence: rounded(verdict.confidence),
        accepted,
      })
      return accepted
    }),
    Effect.catch((error) =>
      Effect.sync(() => {
        logEvent(
          "triage.failed",
          { ...fields, reason: error.reason, accepted: mentioned },
          "warn",
        )
        return mentioned
      }),
    ),
  )
}

function rounded(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 100) / 100
}

/** What the event's own member makes its author, or why it refuses them. */
function admissionOf(
  message: ChatArrival,
  config: Allowlist,
): "no_member" | "not_allowed" | "member" | "admin" {
  if (!message.member) return "no_member"
  const access = accessOf(config, message.author.id, message.member.roles)
  return access === "denied" ? "not_allowed" : access
}

/** Kinds and codes only: provider and platform messages can echo the text. */
function failureFields(platform: ChatPlatform, error: unknown) {
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
  name: string,
  guild: string,
  admin: boolean,
  deps: AdmissionDeps,
) {
  return Effect.gen(function* () {
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
      admin,
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
    // So the thread shows in the member's list without them joining it. The
    // run is queued already and answers whether or not this lands.
    yield* deps.client.addThreadMemberEffect(opened.id, message.author.id).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          logEvent(
            `${deps.platform.name}.member_add_failed`,
            {
              thread: threadKey(thread),
              ...failureFields(deps.platform, error),
            },
            "warn",
          )
        }),
      ),
    )
  }).pipe(Effect.uninterruptible)
}
