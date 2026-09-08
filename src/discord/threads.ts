import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type Client,
  type TextChannel,
} from "discord.js"
import { Effect } from "effect"

import { sdkPromise, SdkError } from "../agent/effect.ts"

const TITLE_PREFIX = "automation: "

/**
 * One private thread per automation inside the watch channel. Private threads
 * are visible to invited members and to anyone with MANAGE_THREADS, which is
 * how "admins only" is achieved without blitzcrank touching permissions.
 * Who may *post* is the channel's permission setup, i.e. operator config.
 */
export class AutomationThreads {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly channelId: string,
  ) {}

  /** Boot check: a watch channel we cannot resolve is a config error. */
  verify(): Promise<string> {
    return Effect.runPromise(this.verifyEffect())
  }
  verifyEffect() {
    return this.channelEffect().pipe(Effect.map((channel) => channel.name))
  }

  get(name: string): Promise<AnyThreadChannel> {
    return Effect.runPromise(this.getEffect(name))
  }
  getEffect(name: string) {
    return Effect.gen({ self: this }, function* () {
      const channel = yield* this.channelEffect()
      const title = `${TITLE_PREFIX}${name}`
      const adopted = yield* this.findEffect(channel, title)
      if (adopted) {
        console.log(`[discord] adopted thread "${title}" (${adopted.id})`)
        return yield* this.usableEffect(adopted)
      }

      const created = yield* sdkPromise(() =>
        channel.threads.create({
          name: title,
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          reason: `blitzcrank automation reports for ${name}`,
        }),
      )
      console.log(`[discord] created thread "${title}" (${created.id})`)
      return created
    })
  }

  /** Reports would 404 into an archived thread, so revive it first. */
  private usableEffect(thread: AnyThreadChannel) {
    return Effect.gen(function* () {
      if (thread.archived)
        yield* sdkPromise<AnyThreadChannel>(() => thread.setArchived(false))
      return thread
    })
  }

  private findEffect(channel: TextChannel, title: string) {
    return Effect.gen(function* () {
      const active = yield* sdkPromise(() => channel.threads.fetch())
      // fetchAll defaults to false, so this hits the "joined archived private
      // threads" route (GET /channels/{id}/users/@me/threads/archived/private),
      // which only needs READ_MESSAGE_HISTORY, not MANAGE_THREADS — fine, since
      // the bot joins every thread it creates. Failure is still tolerated: without it we
      // would rather create a fresh thread than crash the report.
      const archived = yield* sdkPromise(() =>
        channel.threads.fetchArchived({ type: "private" }),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
      return [
        ...active.threads.values(),
        ...(archived?.threads.values() ?? []),
      ].find((thread) => thread.name === title)
    })
  }

  /**
   * The client runs without intents, so nothing is cached from the gateway and
   * the guild must be fetched over REST first: discord.js cannot construct a
   * guild channel (or a thread) whose guild it has never seen.
   */
  private channelEffect() {
    return Effect.gen({ self: this }, function* () {
      const guild = yield* sdkPromise(() =>
        this.client.guilds.fetch(this.guildId),
      )
      const channel = yield* sdkPromise(() =>
        guild.channels.fetch(this.channelId),
      )
      if (!channel || channel.type !== ChannelType.GuildText) {
        return yield* Effect.fail(
          new SdkError({
            message: `DISCORD_WATCH_CHANNEL_ID ${this.channelId} is not a text channel`,
            cause: undefined,
          }),
        )
      }
      return channel
    })
  }
}
