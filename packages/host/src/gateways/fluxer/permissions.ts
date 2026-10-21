import {
  OverwriteType,
  Permission,
  type Overwrite,
  type Role,
} from "./types.ts"

/**
 * Fluxer's permission computation, done locally from what GUILD_CREATE sends,
 * so the gateway can say which bits a watched channel withholds from the bot
 * instead of finding out from a failed post. Pure, and it never throws.
 */

/** What the guild owner and an administrator hold. */
const ALL = (1n << 64n) - 1n

export interface PermissionInput {
  /** The everyone role shares the guild's id. */
  guild: { id: string; ownerId: string }
  roles: readonly Pick<Role, "id" | "permissions">[]
  member: { userId: string; roles: readonly string[] }
  /**
   * Without one, the result is the guild-level mask. A thread has no
   * overwrites of its own: pass its parent.
   */
  channel?:
    | { permission_overwrites?: readonly Overwrite[] | undefined }
    | undefined
}

export function effectivePermissions(input: PermissionInput): bigint {
  if (input.member.userId === input.guild.ownerId) return ALL
  const held = new Set(input.member.roles)
  const base = input.roles
    .filter((role) => role.id === input.guild.id || held.has(role.id))
    .reduce((mask, role) => mask | parseMask(role.permissions), 0n)
  if ((base & Permission.Administrator) !== 0n) return ALL
  const overwrites = input.channel?.permission_overwrites
  if (overwrites === undefined) return base

  const everyone = overwrites.filter(
    (overwrite) =>
      overwrite.type === OverwriteType.Role && overwrite.id === input.guild.id,
  )
  // An allow on any one of the member's roles beats a deny on another.
  const roles = overwrites.filter(
    (overwrite) =>
      overwrite.type === OverwriteType.Role &&
      overwrite.id !== input.guild.id &&
      held.has(overwrite.id),
  )
  const member = overwrites.filter(
    (overwrite) =>
      overwrite.type === OverwriteType.Member &&
      overwrite.id === input.member.userId,
  )
  return [everyone, roles, member].reduce(applyOverwrites, base)
}

/** One step: the union of denies comes off, then the union of allows goes on. */
function applyOverwrites(mask: bigint, step: readonly Overwrite[]): bigint {
  const deny = step.reduce((bits, item) => bits | parseMask(item.deny), 0n)
  const allow = step.reduce((bits, item) => bits | parseMask(item.allow), 0n)
  return (mask & ~deny) | allow
}

/** The bits the bot needs in a watched channel, by their Fluxer names. */
export const REQUIRED_PERMISSIONS: readonly { name: string; bit: bigint }[] = [
  { name: "VIEW_CHANNEL", bit: Permission.ViewChannel },
  // The fixed denial is posted in the channel itself.
  { name: "SEND_MESSAGES", bit: Permission.SendMessages },
  { name: "READ_MESSAGE_HISTORY", bit: Permission.ReadMessageHistory },
  { name: "CREATE_PUBLIC_THREADS", bit: Permission.CreatePublicThreads },
  // A thread takes this from its parent in place of SEND_MESSAGES.
  { name: "SEND_MESSAGES_IN_THREADS", bit: Permission.SendMessagesInThreads },
]

export function missingPermissions(mask: bigint): string[] {
  return REQUIRED_PERMISSIONS.filter(
    (permission) => (mask & permission.bit) === 0n,
  ).map((permission) => permission.name)
}

const DECIMAL = /^\d{1,20}$/

/** A malformed mask holds no bits. `BigInt` would also take hex or a sign. */
function parseMask(value: string): bigint {
  return DECIMAL.test(value) ? BigInt(value) & ALL : 0n
}
