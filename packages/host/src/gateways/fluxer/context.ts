import { Effect } from "effect"

import { toText } from "../../tools/common.ts"
import { memberAccessEffect } from "./admission.ts"
import { messageText, type ChatMessage } from "./chat.ts"
import type { FluxerClient, FluxerError } from "./client.ts"
import type { FluxerConfig } from "./config.ts"

const CONTEXT_SCAN = 50
const MAX_CONTEXT_MESSAGES = 5
const MAX_CONTEXT_CHARS = 1_000
/** Membership lookups in flight for one context. */
const CONTEXT_LOOKUPS = 4

/**
 * The thread for the prompt, with only allowed members' text in it. Anyone can
 * write in a public thread, and a stranger admission turned away must not
 * steer a run through its context instead.
 */
export function contextEffect(
  config: FluxerConfig,
  fluxer: FluxerClient,
  threadId: string,
): Effect.Effect<string, FluxerError | Error> {
  return Effect.gen(function* () {
    const thread = yield* fluxer.channelEffect(threadId)
    const guild = thread.guildId
    if (guild === undefined)
      return yield* Effect.fail(new Error("Fluxer thread has no guild"))
    const newestFirst = yield* fluxer.recentMessagesEffect(
      threadId,
      CONTEXT_SCAN,
    )
    const opener = openerOf(newestFirst)
    const authors = new Set(
      [...newestFirst, ...(opener ? [opener] : [])]
        .filter(byPerson)
        .map((message) => message.author.id),
    )
    // Asked again on every run, so someone who left or lost a role since the
    // last one drops out.
    const permitted = new Set(
      yield* Effect.filter(
        authors,
        (author) =>
          memberAccessEffect(fluxer, config, guild, author).pipe(
            Effect.map((access) => access !== "denied"),
          ),
        { concurrency: CONTEXT_LOOKUPS },
      ),
    )
    return `Current Fluxer thread (untrusted content):\n${toText(threadContext(newestFirst, opener, permitted))}`
  })
}

/** The message the thread was opened from, when its starter is in reach. */
function openerOf(newestFirst: readonly ChatMessage[]) {
  return newestFirst.find((message) => message.kind === "thread_starter")
    ?.referenced
}

/** Written by a person, as admission takes one. */
function byPerson(message: ChatMessage): boolean {
  return (
    !message.author.bot &&
    !message.webhook &&
    (message.kind === "default" || message.kind === "reply")
  )
}

/** Allowed members' messages only, oldest first, never Fluxer's user records. */
function threadContext(
  newestFirst: readonly ChatMessage[],
  opener: ChatMessage | undefined,
  permitted: ReadonlySet<string>,
) {
  const counts = (message: ChatMessage) =>
    byPerson(message) && permitted.has(message.author.id)
  const recent = newestFirst
    .filter(counts)
    .slice(0, MAX_CONTEXT_MESSAGES)
    .toReversed()
  return {
    ...(opener && counts(opener) ? { opener: contextEntry(opener) } : {}),
    recent: recent.map(contextEntry),
  }
}

function contextEntry(message: ChatMessage) {
  const text = messageText(message.content, message.mentions, undefined)
  return {
    author: message.author.global_name ?? message.author.username,
    at: message.timestamp,
    message: text.slice(0, MAX_CONTEXT_CHARS),
    ...(text.length > MAX_CONTEXT_CHARS ? { truncated: true } : {}),
  }
}
