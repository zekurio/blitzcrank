import { effectivePermissions, missingPermissions } from "./permissions.ts"
import {
  ChannelType,
  decode,
  GuildCreate,
  GuildDelete,
  Ready,
  type Channel,
} from "./types.ts"

/**
 * The startup check of the bot's permissions in each watched channel. It
 * reads the guild burst a bot session gets after READY: one GUILD_CREATE per
 * available guild and one GUILD_DELETE per unavailable one. Pure: it takes
 * events and returns a verdict, and leaves waiting and logging to its caller.
 * Only guild and channel ids reach its error text.
 */

/** What the check found, once every guild READY listed has been heard. */
export type AuditVerdict =
  | { ok: true; guilds: number }
  | { ok: false; error: Error }

/** Where a watched channel turned up, and what it lacks there. */
interface Finding {
  guild: string
  type: number
  missing: readonly string[]
}

/** Channels a thread can be opened under. */
const TEXT_TYPES: ReadonlySet<number> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
])

export class StartupAudit {
  /** READY's guilds, once it arrived. */
  private expected: ReadonlySet<string> | undefined = undefined
  /** Guilds that sent GUILD_CREATE or GUILD_DELETE. */
  private readonly seen = new Set<string>()
  /** Guilds seen without a state to check: unavailable, gone, or unreadable. */
  private readonly unchecked = new Set<string>()
  private readonly findings = new Map<string, Finding>()
  private settled = false

  constructor(
    private readonly watched: ReadonlySet<string>,
    private readonly botId: string,
  ) {}

  /**
   * Takes one dispatch. Returns the verdict on the event that completes the
   * burst, and `undefined` before and ever after. Only the first READY counts.
   */
  feed(event: { t: string; d: unknown }): AuditVerdict | undefined {
    if (this.settled) return undefined
    if (event.t === "READY") this.ready(event.d)
    if (event.t === "GUILD_CREATE") this.guildCreate(event.d)
    if (event.t === "GUILD_DELETE") this.guildDelete(event.d)
    const expected = this.expected
    if (expected === undefined) return undefined
    if (![...expected].every((guild) => this.seen.has(guild))) return undefined
    this.settled = true
    return this.verdict(expected.size)
  }

  /** Guilds READY listed that have not been heard from yet. */
  pending(): string[] {
    return [...(this.expected ?? [])].filter((guild) => !this.seen.has(guild))
  }

  private ready(d: unknown): void {
    if (this.expected !== undefined) return
    const ready = decode(Ready, d)
    // The socket decodes READY before it gets here, so this holds.
    if (ready === undefined) return
    this.expected = new Set(ready.guilds.map((guild) => guild.id))
  }

  private guildCreate(d: unknown): void {
    const guild = decode(GuildCreate, d)
    // Heard from, but nothing in it can be trusted for the check.
    if (guild === undefined) return this.lose(decode(GuildDelete, d)?.id)
    this.seen.add(guild.id)
    this.unchecked.delete(guild.id)
    // Without a member of its own, the bot holds the everyone role alone.
    const roles =
      guild.members.find((member) => member.user.id === this.botId)?.roles ?? []
    for (const channel of guild.channels) {
      if (this.watched.has(channel.id))
        this.findings.set(channel.id, {
          guild: guild.id,
          type: channel.type,
          missing: this.missing(guild, roles, channel),
        })
    }
  }

  private guildDelete(d: unknown): void {
    this.lose(decode(GuildDelete, d)?.id)
  }

  /** The guild was heard from, and none of its channels can be checked. */
  private lose(guild: string | undefined): void {
    if (guild === undefined) return
    this.seen.add(guild)
    this.unchecked.add(guild)
    for (const [channel, finding] of this.findings) {
      if (finding.guild === guild) this.findings.delete(channel)
    }
  }

  private missing(
    guild: GuildCreate,
    roles: readonly string[],
    channel: Channel,
  ): readonly string[] {
    return missingPermissions(
      effectivePermissions({
        guild: { id: guild.id, ownerId: guild.properties.owner_id },
        roles: guild.roles,
        member: { userId: this.botId, roles },
        channel,
      }),
    )
  }

  private verdict(guilds: number): AuditVerdict {
    const problems = [...this.watched].flatMap((id) => {
      const finding = this.findings.get(id)
      if (finding === undefined) return [this.notFound(id)]
      if (!TEXT_TYPES.has(finding.type))
        return [
          `Fluxer channel ${id} is not a text or announcement channel (type ${finding.type})`,
        ]
      if (finding.missing.length > 0)
        return [
          `Fluxer channel ${id} is missing ${finding.missing.join(", ")} for the bot`,
        ]
      return []
    })
    if (problems.length === 0) return { ok: true, guilds }
    return { ok: false, error: new Error(problems.join("; ")) }
  }

  private notFound(id: string): string {
    const unchecked = [...this.unchecked]
    const note =
      unchecked.length === 0
        ? ""
        : ` (could not check guild ${unchecked.join(", ")})`
    return `Fluxer channel ${id} was not found in any guild available to the bot, or the bot cannot view it${note}`
  }
}
