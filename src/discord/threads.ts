import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

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
  private ids: Record<string, string> | undefined

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly channelId: string,
    private readonly filePath: string,
  ) {}

  /** Boot check: a watch channel we cannot resolve is a config error. */
  async verify(): Promise<string> {
    return (await this.channel()).name
  }

  async get(name: string): Promise<AnyThreadChannel> {
    const channel = await this.channel()
    const ids = await this.load()
    const known = ids[name]
    if (known) {
      const thread = await this.client.channels
        .fetch(known)
        .catch(() => undefined)
      if (thread?.isThread()) return this.usable(thread)
    }

    const title = `${TITLE_PREFIX}${name}`
    const adopted = await this.find(channel, title)
    if (adopted) {
      await this.remember(name, adopted.id)
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
    await this.remember(name, created.id)
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
    // Listing archived private threads needs MANAGE_THREADS; without it we
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

  private async load(): Promise<Record<string, string>> {
    if (this.ids) return this.ids
    const raw = await readFile(this.filePath, "utf8").catch(() => "{}")
    this.ids = JSON.parse(raw) as Record<string, string>
    return this.ids
  }

  private async remember(name: string, id: string): Promise<void> {
    const ids = await this.load()
    ids[name] = id
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(ids, null, 2)}\n`)
  }
}
