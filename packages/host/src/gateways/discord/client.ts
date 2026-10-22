import {
  API,
  ThreadAutoArchiveDuration,
  type APIChannel,
  type APIGuildMember,
  type APIMessage,
  type APIUser,
  type RESTPostAPIChannelThreadsResult,
} from "@discordjs/core"
import { DiscordAPIError, HTTPError, REST } from "@discordjs/rest"
import { Data, Effect } from "effect"

export class DiscordError extends Data.TaggedError("DiscordError")<{
  /** HTTP status, when Discord answered. */
  status: number | undefined
  /** Discord's JSON error code, such as 10008 for an unknown message. */
  code: number | string | undefined
  cause: unknown
}> {}

/** No post may ping anyone, whatever the text says. */
const NO_PINGS = { parse: [], replied_user: false }

/**
 * The gateway's REST access to Discord. It exists from startup, before the
 * socket opens and after it closes, so recovery and draining runs can use it.
 */
export class DiscordClient {
  readonly rest: REST
  private readonly api: API

  constructor(token: string) {
    // No retries: repeating a post after a timeout can post it twice.
    this.rest = new REST({ version: "10", retries: 0 }).setToken(token)
    this.api = new API(this.rest)
  }

  currentUserEffect(): Effect.Effect<APIUser, DiscordError> {
    return call((signal) => this.api.users.getCurrent({ signal }))
  }

  channelEffect(channelId: string): Effect.Effect<APIChannel, DiscordError> {
    return call((signal) => this.api.channels.get(channelId, { signal }))
  }

  /** The member, or `undefined` once they have left the guild. */
  memberEffect(
    guildId: string,
    userId: string,
  ): Effect.Effect<APIGuildMember | undefined, DiscordError> {
    return call((signal) =>
      this.api.guilds.getMember(guildId, userId, { signal }),
    ).pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeed(undefined),
      ),
    )
  }

  /** Newest first, as Discord returns them. */
  recentMessagesEffect(
    channelId: string,
    limit: number,
  ): Effect.Effect<APIMessage[], DiscordError> {
    return call((signal) =>
      this.api.channels.getMessages(channelId, { limit }, { signal }),
    )
  }

  startThreadEffect(
    channelId: string,
    messageId: string,
    name: string,
  ): Effect.Effect<RESTPostAPIChannelThreadsResult, DiscordError> {
    return call((signal) =>
      this.api.channels.createThread(
        channelId,
        { name, auto_archive_duration: ThreadAutoArchiveDuration.OneDay },
        messageId,
        { signal },
      ),
    )
  }

  /** Discord answers the same for someone who is a member already. */
  addThreadMemberEffect(
    threadId: string,
    userId: string,
  ): Effect.Effect<void, DiscordError> {
    return call((signal) =>
      this.api.threads.addMember(threadId, userId, { signal }),
    )
  }

  postEffect(
    channelId: string,
    content: string,
    replyTo?: string,
  ): Effect.Effect<APIMessage, DiscordError> {
    return call((signal) =>
      this.api.channels.createMessage(
        channelId,
        {
          content,
          allowed_mentions: NO_PINGS,
          ...(replyTo === undefined
            ? {}
            : {
                message_reference: {
                  message_id: replyTo,
                  fail_if_not_exists: false,
                },
              }),
        },
        { signal },
      ),
    )
  }

  editEffect(
    channelId: string,
    messageId: string,
    content: string,
  ): Effect.Effect<APIMessage, DiscordError> {
    return call((signal) =>
      this.api.channels.editMessage(
        channelId,
        messageId,
        { content, allowed_mentions: NO_PINGS },
        { signal },
      ),
    )
  }

  /** A message that is already gone counts as deleted. */
  deleteEffect(
    channelId: string,
    messageId: string,
  ): Effect.Effect<void, DiscordError> {
    return call((signal) =>
      this.api.channels.deleteMessage(channelId, messageId, { signal }),
    ).pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.void,
      ),
    )
  }
}

function call<A>(
  request: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, DiscordError> {
  return Effect.tryPromise({
    try: request,
    catch: (cause) =>
      new DiscordError({
        status:
          cause instanceof DiscordAPIError || cause instanceof HTTPError
            ? cause.status
            : undefined,
        code: cause instanceof DiscordAPIError ? cause.code : undefined,
        cause,
      }),
  })
}
