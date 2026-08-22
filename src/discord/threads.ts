import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type Client,
  type TextChannel,
} from "discord.js"

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
  async verify(): Promise<string> {
    return (await this.channel()).name
  }

  async get(name: string): Promise<AnyThreadChannel> {
    const channel = await this.channel()
    const title = `${TITLE_PREFIX}${name}`
    const adopted = await this.find(channel, title)
    if (adopted) {
      console.log(`[discord] adopted thread "${title}" (${adopted.id})`)
      return this.usable(adopted)
    }

    const created = await channel.threads.create({
      name: title,
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `blitzcrank automation reports for ${name}`,
    })
    console.log(`[discord] created thread "${title}" (${created.id})`)
    return created
  }

  /** Reports would 404 into an archived thread, so revive it first. */
  private async usable(thread: AnyThreadChannel): Promise<AnyThreadChannel> {
    if (thread.archived) await thread.setArchived(false)
    return thread
  }

  private async find(
    channel: TextChannel,
    title: string,
  ): Promise<AnyThreadChannel | undefined> {
    const active = await channel.threads.fetch()
    // fetchAll defaults to false, so this hits the "joined archived private
    // threads" route (GET /channels/{id}/users/@me/threads/archived/private),
    // which only needs READ_MESSAGE_HISTORY, not MANAGE_THREADS — fine, since
    // the bot joins every thread it creates. Still `.catch()`d: without it we
    // would rather create a fresh thread than crash the report.
    const archived = await channel.threads
      .fetchArchived({ type: "private" })
      .catch(() => undefined)
    return [
      ...active.threads.values(),
      ...(archived?.threads.values() ?? []),
    ].find((thread) => thread.name === title)
  }

  /**
   * The client runs without intents, so nothing is cached from the gateway and
   * the guild must be fetched over REST first: discord.js cannot construct a
   * guild channel (or a thread) whose guild it has never seen.
   */
  private async channel(): Promise<TextChannel> {
    const guild = await this.client.guilds.fetch(this.guildId)
    const channel = await guild.channels.fetch(this.channelId)
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(
        `DISCORD_WATCH_CHANNEL_ID ${this.channelId} is not a text channel`,
      )
    }
    return channel
  }
}
