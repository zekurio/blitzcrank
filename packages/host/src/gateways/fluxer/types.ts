import { Type, type Static, type TSchema } from "typebox"
import { Check } from "typebox/value"

/**
 * The Fluxer wire shapes the gateway reads, and no field it does not. Fluxer
 * adds fields freely and a check ignores them, so a schema only pins what
 * code downstream relies on. Ids end up in REST paths, so a snowflake must be
 * the digits Fluxer emits and nothing else.
 */

export const Snowflake = Type.String({ pattern: "^[0-9]{1,20}$" })

/**
 * Permission masks exceed 2^53, so Fluxer sends them as decimal strings. A
 * mask that is not one fails the whole object rather than reading as no bits,
 * which for a deny would grant.
 */
const Mask = Type.String({ pattern: "^[0-9]{1,20}$" })

const Nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()])

export const PartialUser = Type.Object({
  id: Snowflake,
  username: Type.String(),
  // Documented as always present. A deleted-user placeholder may still omit
  // it, and one such author must not fail a whole page of messages.
  global_name: Type.Optional(Nullable(Type.String())),
  bot: Type.Optional(Type.Boolean()),
})
export type PartialUser = Static<typeof PartialUser>

/** A member over REST, or `member` on a message event, which drops `user`. */
export const GuildMember = Type.Object({
  user: Type.Optional(Type.Object({ id: Snowflake })),
  /** Never includes the everyone role. */
  roles: Type.Array(Snowflake),
  communication_disabled_until: Type.Optional(Nullable(Type.String())),
})
export type GuildMember = Static<typeof GuildMember>

const messageFields = {
  id: Snowflake,
  channel_id: Snowflake,
  author: PartialUser,
  /** Null on the starter message Fluxer builds for a thread, else absent. */
  webhook_id: Type.Optional(Nullable(Snowflake)),
  type: Type.Integer(),
  content: Type.String(),
  timestamp: Type.String(),
  mentions: Type.Array(PartialUser),
  mention_roles: Type.Array(Snowflake),
}

/** Fluxer never nests a reference inside a referenced message. */
export const ReferencedMessage = Type.Object(messageFields)
export type ReferencedMessage = Static<typeof ReferencedMessage>

export const Message = Type.Object({
  ...messageFields,
  /** Absent without a reference, null once its target is gone. */
  referenced_message: Type.Optional(Nullable(ReferencedMessage)),
})
export type Message = Static<typeof Message>

export const MessageCreate = Type.Object({
  ...Message.properties,
  channel_type: Type.Integer(),
  guild_id: Type.Optional(Snowflake),
  member: Type.Optional(GuildMember),
})
export type MessageCreate = Static<typeof MessageCreate>

export const Overwrite = Type.Object({
  id: Snowflake,
  type: Type.Integer(),
  allow: Mask,
  deny: Mask,
})
export type Overwrite = Static<typeof Overwrite>

export const Role = Type.Object({
  id: Snowflake,
  name: Type.String(),
  position: Type.Integer(),
  permissions: Mask,
})
export type Role = Static<typeof Role>

/** A channel or a thread. A thread has no overwrites of its own. */
export const Channel = Type.Object({
  id: Snowflake,
  type: Type.Integer(),
  guild_id: Type.Optional(Snowflake),
  name: Type.Optional(Nullable(Type.String())),
  /** A thread's parent channel, or a channel's category. */
  parent_id: Type.Optional(Nullable(Snowflake)),
  owner_id: Type.Optional(Nullable(Snowflake)),
  permission_overwrites: Type.Optional(Type.Array(Overwrite)),
})
export type Channel = Static<typeof Channel>

/**
 * A guild as a bot session receives it. In the burst after Ready, a member's
 * `user` is cut down to its id, and `members` holds the bot's own member.
 */
export const GuildCreate = Type.Object({
  id: Snowflake,
  properties: Type.Object({ owner_id: Snowflake }),
  roles: Type.Array(Role),
  channels: Type.Array(Channel),
  members: Type.Array(
    Type.Object({
      user: Type.Object({ id: Snowflake }),
      roles: Type.Array(Snowflake),
    }),
  ),
  unavailable: Type.Optional(Type.Boolean()),
})
export type GuildCreate = Static<typeof GuildCreate>

/** Without `unavailable`, the bot is no longer in the guild. */
export const GuildDelete = Type.Object({
  id: Snowflake,
  unavailable: Type.Optional(Type.Boolean()),
})
export type GuildDelete = Static<typeof GuildDelete>

export const Ready = Type.Object({
  session_id: Type.String({ minLength: 1 }),
  user: Type.Object({ id: Snowflake }),
  guilds: Type.Array(
    Type.Object({
      id: Snowflake,
      unavailable: Type.Optional(Type.Boolean()),
    }),
  ),
})
export type Ready = Static<typeof Ready>

export const Hello = Type.Object({
  heartbeat_interval: Type.Number({ exclusiveMinimum: 0 }),
})
export type Hello = Static<typeof Hello>

/** `s` and `t` come only with a dispatch. */
export const GatewayPayload = Type.Object({
  op: Type.Integer(),
  d: Type.Optional(Type.Unknown()),
  s: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
  t: Type.Optional(Nullable(Type.String())),
})
export type GatewayPayload = Static<typeof GatewayPayload>

export const CurrentApplication = Type.Object({
  id: Snowflake,
  name: Type.String(),
  /** Its id is the application's: the bot user is the application. */
  bot: Type.Optional(Type.Object({ id: Snowflake, username: Type.String() })),
})
export type CurrentApplication = Static<typeof CurrentApplication>

/** The instance's endpoints, from `/.well-known/fluxer`. */
export const Discovery = Type.Object({
  endpoints: Type.Object({
    api_public: Type.String(),
    gateway: Type.String(),
  }),
})
export type Discovery = Static<typeof Discovery>

/**
 * The part of an error body that goes into logs. The pattern keeps anything
 * but a symbolic code, such as echoed message text, out of them.
 */
export const ErrorBody = Type.Object({
  code: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" }),
})

/** A 429 body says how long to wait, in fractional seconds. */
export const RateLimitBody = Type.Object({
  retry_after: Type.Number({ minimum: 0 }),
})

export const ChannelType = {
  GuildText: 0,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
} as const

export const MessageType = {
  Default: 0,
  Reply: 19,
  /** Built on read as a thread's first message; it references its source. */
  ThreadStarterMessage: 21,
} as const

export const Opcode = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Resume: 6,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const

export const OverwriteType = {
  Role: 0,
  Member: 1,
} as const

export const Permission = {
  Administrator: 1n << 3n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  ReadMessageHistory: 1n << 16n,
  CreatePublicThreads: 1n << 35n,
  SendMessagesInThreads: 1n << 38n,
} as const

/**
 * Closes that reconnecting unchanged would only repeat: a bad token, shard,
 * or version, or a payload this client built wrong.
 */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  4002, 4004, 4010, 4011, 4012,
])

/** The value as its schema types it, or `undefined` when it does not fit. */
export function decode<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T> | undefined {
  return Check(schema, value) ? value : undefined
}
