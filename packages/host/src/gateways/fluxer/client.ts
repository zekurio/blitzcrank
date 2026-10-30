import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Random,
  type Scope,
} from "effect"
import { Type, type Static, type TSchema } from "typebox"

import { errorKind, logEvent } from "../../log.ts"
import {
  jsonRequestEffect,
  type JsonRequestError,
  type JsonRequestOptions,
  type JsonValue,
} from "../../services/http.ts"
import type {
  ChatChannel,
  ChatClient,
  ChatMember,
  ChatMessage,
  MessageKind,
} from "../chat.ts"
import {
  Channel,
  ChannelType,
  CurrentApplication,
  decode,
  Discovery,
  ErrorBody,
  FATAL_CLOSE_CODES,
  GatewayPayload,
  GuildMember,
  Hello,
  Message,
  MessageType,
  Opcode,
  RateLimitBody,
  Ready,
  Snowflake,
} from "./types.ts"

export class FluxerError extends Data.TaggedError("FluxerError")<{
  /** HTTP status, when Fluxer answered. */
  status: number | undefined
  /**
   * Fluxer's symbolic code, such as `UNKNOWN_MESSAGE`, or `malformed` for an
   * answer without the documented shape.
   */
  code: string | undefined
  /** Seconds to wait before the route admits another request, from a 429. */
  retryAfter: number | undefined
  cause: unknown
}> {
  /** Status and code only: a body can echo what was sent. */
  override get message(): string {
    return `Fluxer request failed (status ${this.status ?? "none"}, code ${this.code ?? "none"})`
  }
}

/** Where one instance serves its API and its gateway. */
export interface Endpoints {
  /** REST base without `/v1` or a trailing slash, e.g. https://api.fluxer.app. */
  api: string
  /** The gateway's WebSocket URL, exactly as published. */
  gateway: string
}

const DISCOVERY_TIMEOUT_MS = 30_000

/**
 * Reads the instance's endpoints from its discovery document. The document is
 * public, so the request carries no token, and it may redirect to the host
 * that serves it. Fluxer requires its endpoints be used as published, so
 * nothing about them is upgraded or rewritten.
 */
export function discoverEffect(
  instance: string,
): Effect.Effect<Endpoints, FluxerError> {
  // An https instance gets its endpoints over TLS or not at all: the token
  // goes out on every REST call and in Identify. A plaintext instance is the
  // operator's choice, and keeps its plain endpoints.
  const secure = instance.startsWith("https:")
  const apiSchemes = secure ? ["https:"] : ["https:", "http:"]
  const gatewaySchemes = secure ? ["wss:"] : ["wss:", "ws:"]
  return jsonRequestEffect<unknown>(instance, ".well-known/fluxer", {
    timeoutMs: DISCOVERY_TIMEOUT_MS,
  }).pipe(
    Effect.catch(fluxerErrorEffect),
    Effect.flatMap((body) => {
      const endpoints = decode(Discovery, body)?.endpoints
      const api = endpoints && published(endpoints.api_public, apiSchemes)
      const gateway = endpoints && published(endpoints.gateway, gatewaySchemes)
      if (api === undefined || gateway === undefined)
        return Effect.fail(malformed())
      return Effect.succeed({ api: api.replace(/\/+$/, ""), gateway })
    }),
  )
}

function published(
  value: string,
  schemes: readonly string[],
): string | undefined {
  const url = URL.parse(value)
  return url !== null && schemes.includes(url.protocol) ? value : undefined
}

/** No post may ping anyone, whatever the text says. */
const NO_PINGS: JsonValue = { parse: [], replied_user: false }

/** Minutes: a thread archives after a day without messages. */
const ONE_DAY = 1440

/** Path segments only: ids, `@me`, and route words. */
const SEGMENT = /^[\w@-]+$/

/** A read waits out a route bucket this long at most, once. */
const RETRY_AFTER_CAP_SECONDS = 10

const Messages = Type.Array(Message)

export const THREAD_TYPES: ReadonlySet<number> = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
])

const MESSAGE_KINDS: ReadonlyMap<number, MessageKind> = new Map([
  [MessageType.Default, "default"],
  [MessageType.Reply, "reply"],
  [MessageType.ThreadStarterMessage, "thread_starter"],
])

/**
 * What the host keeps of a write: the new message's or thread's id. Reading
 * no more keeps a write that landed from being reported as failed over a
 * field this client never uses.
 */
const Written = Type.Object({ id: Snowflake })
type Written = Static<typeof Written>

/**
 * The gateway's REST access to Fluxer. It exists from startup, before the
 * socket opens and after it closes, so recovery and draining runs can use it.
 * Nothing is retried: repeating a post after a timeout can post it twice, and
 * Fluxer bans an address that keeps sending a rejected token.
 */
export class FluxerClient implements ChatClient {
  private readonly base: string
  private readonly authorization: string

  constructor(endpoints: Endpoints, token: string) {
    this.base = `${endpoints.api}/v1`
    this.authorization = `Bot ${token}`
  }

  /** Also checks the token: Fluxer answers 401 `INVALID_TOKEN` otherwise. */
  currentApplicationEffect(): Effect.Effect<CurrentApplication, FluxerError> {
    return this.requestEffect(CurrentApplication, ["applications", "@me"])
  }

  channelEffect(channelId: string): Effect.Effect<ChatChannel, FluxerError> {
    return this.requestEffect(Channel, ["channels", channelId]).pipe(
      Effect.map(chatChannel),
    )
  }

  memberEffect(
    guildId: string,
    userId: string,
  ): Effect.Effect<ChatMember | undefined, FluxerError> {
    return this.requestEffect(GuildMember, [
      "guilds",
      guildId,
      "members",
      userId,
    ]).pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeed(undefined),
      ),
    )
  }

  recentMessagesEffect(
    channelId: string,
    limit: number,
  ): Effect.Effect<ChatMessage[], FluxerError> {
    return this.requestEffect(Messages, ["channels", channelId, "messages"], {
      query: { limit },
    }).pipe(Effect.map((messages) => messages.map(chatMessage)))
  }

  /** The thread takes the message's id. */
  startThreadEffect(
    channelId: string,
    messageId: string,
    name: string,
  ): Effect.Effect<Written, FluxerError> {
    return this.requestEffect(
      Written,
      ["channels", channelId, "messages", messageId, "threads"],
      {
        method: "POST",
        body: { name, auto_archive_duration: ONE_DAY },
      },
    )
  }

  /**
   * Fluxer makes only a thread's creator a member, so whoever wrote the
   * message it hangs off would have to join it to follow it. Adding them
   * posts a system line in the thread; adding someone already in it does
   * nothing.
   */
  addThreadMemberEffect(
    threadId: string,
    userId: string,
  ): Effect.Effect<void, FluxerError> {
    return this.callEffect(["channels", threadId, "thread-members", userId], {
      method: "PUT",
    }).pipe(Effect.asVoid)
  }

  /** A reply to a message that is gone fails with `UNKNOWN_MESSAGE`. */
  postEffect(
    channelId: string,
    content: string,
    replyTo?: string,
  ): Effect.Effect<Written, FluxerError> {
    return this.requestEffect(Written, ["channels", channelId, "messages"], {
      method: "POST",
      body: {
        content,
        allowed_mentions: NO_PINGS,
        ...(replyTo === undefined
          ? {}
          : { message_reference: { message_id: replyTo } }),
      },
    })
  }

  editEffect(
    channelId: string,
    messageId: string,
    content: string,
  ): Effect.Effect<void, FluxerError> {
    return this.requestEffect(
      Written,
      ["channels", channelId, "messages", messageId],
      { method: "PATCH", body: { content, allowed_mentions: NO_PINGS } },
    ).pipe(Effect.asVoid)
  }

  deleteEffect(
    channelId: string,
    messageId: string,
  ): Effect.Effect<void, FluxerError> {
    return this.callEffect(["channels", channelId, "messages", messageId], {
      method: "DELETE",
    }).pipe(
      Effect.asVoid,
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.void,
      ),
    )
  }

  private requestEffect<T extends TSchema>(
    schema: T,
    segments: readonly string[],
    options: JsonRequestOptions = {},
  ): Effect.Effect<Static<T>, FluxerError> {
    return this.callEffect(segments, options).pipe(
      Effect.flatMap((body) => {
        const value = decode(schema, body)
        return value === undefined
          ? Effect.fail(malformed())
          : Effect.succeed(value)
      }),
    )
  }

  private callEffect(
    segments: readonly string[],
    options: JsonRequestOptions,
  ): Effect.Effect<unknown, FluxerError> {
    // Ids come from events and stored state. Only a plain segment reaches a
    // path, so none can climb out of the route it names.
    if (!segments.every((segment) => SEGMENT.test(segment)))
      return Effect.fail(
        new FluxerError({
          status: undefined,
          code: "invalid_path",
          retryAfter: undefined,
          cause: undefined,
        }),
      )
    const request = jsonRequestEffect<unknown>(this.base, segments.join("/"), {
      ...options,
      headers: { authorization: this.authorization },
    }).pipe(Effect.catch(fluxerErrorEffect))
    if ((options.method ?? "GET") !== "GET") return request
    // A read repeats safely, and one wait covers the burst of member lookups
    // a context makes against the per-guild bucket. A write is never
    // repeated: its first attempt may have landed.
    return request.pipe(
      Effect.catchIf(
        (error) =>
          error.status === 429 &&
          error.retryAfter !== undefined &&
          error.retryAfter <= RETRY_AFTER_CAP_SECONDS,
        (error) =>
          Effect.sleep(Math.ceil((error.retryAfter ?? 0) * 1000)).pipe(
            Effect.andThen(request),
          ),
      ),
    )
  }
}

export function chatMessage(message: Message): ChatMessage {
  return {
    id: message.id,
    author: message.author,
    // Null on the starter message Fluxer builds for a thread.
    webhook: typeof message.webhook_id === "string",
    kind: MESSAGE_KINDS.get(message.type) ?? "other",
    content: message.content,
    mentions: message.mentions,
    timestamp: message.timestamp,
    referenced: message.referenced_message
      ? chatMessage(message.referenced_message)
      : undefined,
  }
}

function chatChannel(channel: Channel): ChatChannel {
  return {
    thread: THREAD_TYPES.has(channel.type),
    guildId: channel.guild_id,
    parentId: channel.parent_id ?? undefined,
    ownerId: channel.owner_id ?? undefined,
  }
}

function malformed(): FluxerError {
  return new FluxerError({
    status: undefined,
    code: "malformed",
    retryAfter: undefined,
    cause: undefined,
  })
}

/** Keeps the status and Fluxer's code; the body stays in `cause`. */
function fluxerErrorEffect(
  error: JsonRequestError,
): Effect.Effect<never, FluxerError> {
  if (error._tag === "HttpResponseError")
    return Effect.fail(
      new FluxerError({
        status: undefined,
        code: "malformed",
        retryAfter: undefined,
        cause: error,
      }),
    )
  if (error._tag !== "HttpError")
    return Effect.fail(
      new FluxerError({
        status: undefined,
        code: undefined,
        retryAfter: undefined,
        cause: error,
      }),
    )
  return Effect.try({
    try: (): unknown => JSON.parse(error.body),
    catch: () => undefined,
  }).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((body) =>
      Effect.fail(
        new FluxerError({
          status: error.status,
          code: decode(ErrorBody, body)?.code,
          retryAfter: decode(RateLimitBody, body)?.retry_after,
          cause: error,
        }),
      ),
    ),
  )
}

/** One gateway event, in order, with its sequence. */
export interface Dispatch {
  t: string
  d: unknown
  s: number
}

/** What a bot that reads only messages and guilds never needs to hear. */
const IGNORED_EVENTS = [
  "TYPING_START",
  "MESSAGE_REACTION_ADD",
  "MESSAGE_REACTION_REMOVE",
  "MESSAGE_REACTION_REMOVE_ALL",
  "MESSAGE_REACTION_REMOVE_EMOJI",
  "MESSAGE_REACTION_ADD_MANY",
  "PRESENCE_UPDATE",
  "VOICE_STATE_UPDATE",
  "MESSAGE_ACK",
  "CHANNEL_PINS_UPDATE",
  "CHANNEL_PINS_ACK",
]

const IDENTIFY_PROPERTIES = {
  os: process.platform,
  browser: "blitzcrank",
  device: "blitzcrank",
}

const READY_TIMEOUT = "60 seconds"
/** One socket's time from opening to READY or RESUMED. */
const START_TIMEOUT = "60 seconds"
const CLOSE_TIMEOUT = "5 seconds"
const BACKOFF_FIRST_MS = 1_000
const BACKOFF_MAX_MS = 60_000
const IDENTIFY_PAUSE_MIN_MS = 1_000
const IDENTIFY_PAUSE_MAX_MS = 5_000
/** A sequence outside the session's bounds. Resuming from it fails again. */
const INVALID_SEQUENCE = 4007
/**
 * For a socket this client drops to reconnect. Fluxer keeps the session for
 * a resume whatever the code; 1000 is the goodbye of a closing scope.
 */
const RECONNECT_CLOSE = 4000

type SocketEvent =
  | { kind: "message"; data: unknown }
  | { kind: "error"; error: string }
  | { kind: "close"; code: number; reason: string }
  /** The heartbeat interval passed. */
  | { kind: "beat" }
  /** START_TIMEOUT passed since the socket opened. */
  | { kind: "stalled" }

/** Why one socket's life ended. */
type Ending =
  /** It closed under this client. */
  | { kind: "closed"; code: number; reason: string }
  /** This client dropped it, and the next socket resumes. */
  | { kind: "dropped" }
  /** Op 9: the session is gone, and the next socket identifies. */
  | { kind: "invalid" }

const DROPPED: Ending = { kind: "dropped" }
const INVALID: Ending = { kind: "invalid" }

/** The session across sockets. Only the session fiber touches it. */
interface Session {
  readonly url: string
  readonly token: string
  readonly onDispatch: (event: Dispatch) => void
  /** Told of a fatal close after the first READY. */
  readonly onDead: (error: Error) => Effect.Effect<void>
  /** Succeeds with the first READY, or fails on a fatal close before it. */
  readonly ready: Deferred.Deferred<void, Error>
  /** READY's session id, while a resume may still find it. */
  id: string | undefined
  /** The last dispatch sequence handled, for heartbeats and a resume. */
  seq: number | null
  /** Sockets in a row that ended without READY or RESUMED. */
  failures: number
}

interface Connection {
  readonly ws: WebSocket
  readonly events: Queue.Queue<SocketEvent>
  /** Whether the last heartbeat this client sent was acknowledged. */
  acked: boolean
  /** HELLO arrived and the heartbeat runs. */
  beating: boolean
  /** READY or RESUMED arrived on this socket. */
  established: boolean
}

/**
 * The gateway session that brings new messages. It succeeds once the first
 * READY has reached `onDispatch`, then keeps the session alive in the
 * caller's scope: heartbeats, a resume after a drop, a fresh identify when
 * the session is gone, and backoff between sockets. A close that reconnecting
 * cannot fix ends the session: before READY it fails this, and after READY
 * it goes to `onDead`, since no message arrives without the socket. Closing
 * the scope closes the socket.
 */
export function connectSocketEffect(
  endpoints: Endpoints,
  token: string,
  onDispatch: (event: Dispatch) => void,
  onDead: (error: Error) => Effect.Effect<void>,
): Effect.Effect<void, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const session: Session = {
      url: yield* socketUrlEffect(endpoints.gateway),
      token,
      onDispatch,
      onDead,
      ready: yield* Deferred.make<void, Error>(),
      id: undefined,
      seq: null,
      failures: 0,
    }
    const fiber = yield* Effect.forkScoped(sessionEffect(session))
    yield* Deferred.await(session.ready).pipe(
      Effect.timeoutOrElse({
        duration: READY_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new Error(`Fluxer gateway was not ready within ${READY_TIMEOUT}`),
          ),
      }),
      Effect.onError(() => Fiber.interrupt(fiber)),
    )
  })
}

/** JSON in text frames, uncompressed: no `compress` parameter. */
function socketUrlEffect(gateway: string): Effect.Effect<string, Error> {
  return Effect.try({
    try: () => {
      const url = new URL(gateway)
      url.searchParams.set("v", "1")
      url.searchParams.set("encoding", "json")
      return url.href
    },
    catch: () =>
      new Error("Fluxer published a gateway URL that does not parse"),
  })
}

/**
 * One socket after another, until the scope ends it or a close that
 * reconnecting cannot fix. That close fails `ready` while startup still waits
 * on it, and goes to `onDead` once READY has come.
 */
function sessionEffect(session: Session): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (;;) {
      const ending = yield* connectionEffect(session)
      if (ending.kind === "closed" && FATAL_CLOSE_CODES.has(ending.code)) {
        logEvent("fluxer.socket_dead", { code: ending.code }, "error")
        const error = fatalError(ending)
        const starting = yield* Deferred.fail(session.ready, error)
        if (!starting) yield* session.onDead(error)
        return
      }
      if (
        ending.kind === "invalid" ||
        (ending.kind === "closed" && ending.code === INVALID_SEQUENCE)
      ) {
        session.id = undefined
        session.seq = null
      }
      session.failures += 1
      logEvent("fluxer.socket_reconnecting", {
        attempt: session.failures,
        resume: session.id !== undefined,
      })
      yield* Effect.sleep(yield* pauseEffect(ending, session.failures))
    }
  })
}

function fatalError(ending: { code: number; reason: string }): Error {
  if (ending.code === 4004) return new Error("Fluxer rejected FLUXER_BOT_TOKEN")
  const reason = ending.reason ? ` (${ending.reason})` : ""
  return new Error(`Fluxer gateway closed with ${ending.code}${reason}`)
}

/**
 * Exponential from one second to a minute, jittered so sockets that dropped
 * together do not all return together. A fresh identify also waits one to
 * five seconds.
 */
function pauseEffect(ending: Ending, attempt: number): Effect.Effect<number> {
  const ceiling = Math.min(
    BACKOFF_MAX_MS,
    BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt - 1),
  )
  return Effect.gen(function* () {
    const backoff = yield* Random.nextBetween(ceiling / 2, ceiling)
    if (ending.kind !== "invalid") return backoff
    const pause = yield* Random.nextBetween(
      IDENTIFY_PAUSE_MIN_MS,
      IDENTIFY_PAUSE_MAX_MS,
    )
    return Math.max(backoff, pause)
  })
}

/**
 * One socket from open to close. It never fails: whatever ends it is an
 * ending the session loop acts on. Its timers and the socket itself close
 * with its scope.
 */
function connectionEffect(session: Session): Effect.Effect<Ending> {
  return Effect.gen(function* () {
    const events = yield* Queue.unbounded<SocketEvent>()
    const ws = yield* Effect.acquireRelease(
      openEffect(session.url, events),
      (socket, exit) =>
        closeEffect(socket, Exit.hasInterrupts(exit) ? 1000 : RECONNECT_CLOSE),
    )
    const connection: Connection = {
      ws,
      events,
      acked: true,
      beating: false,
      established: false,
    }
    yield* Effect.sleep(START_TIMEOUT).pipe(
      Effect.andThen(Queue.offer(events, { kind: "stalled" })),
      Effect.forkScoped,
    )
    for (;;) {
      const event = yield* Queue.take(events)
      const ending = yield* handleEffect(session, connection, event)
      if (ending !== undefined) return ending
    }
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      logEvent(
        "fluxer.socket_error",
        { error: errorKind(Cause.squash(cause)) },
        "warn",
      )
      return Effect.succeed(DROPPED)
    }),
  )
}

function openEffect(
  url: string,
  events: Queue.Queue<SocketEvent>,
): Effect.Effect<WebSocket, Error> {
  return Effect.try({
    try: () => {
      const ws = new WebSocket(url)
      // Socket callbacks cannot await. The connection's fiber takes what they
      // queue, in order; a socket left behind queues for nobody.
      ws.addEventListener("message", (event) => {
        const data: unknown = event.data
        Queue.offerUnsafe(events, { kind: "message", data })
      })
      ws.addEventListener("error", (event) => {
        Queue.offerUnsafe(events, {
          kind: "error",
          error: errorKind(event.error),
        })
      })
      ws.addEventListener("close", (event) => {
        Queue.offerUnsafe(events, {
          kind: "close",
          code: event.code,
          reason: event.reason,
        })
      })
      return ws
    },
    catch: (cause) =>
      new Error("Fluxer gateway socket did not open", { cause }),
  })
}

/** Waits for the close handshake, but not past CLOSE_TIMEOUT. */
function closeEffect(ws: WebSocket, code: number): Effect.Effect<void> {
  if (ws.readyState === WebSocket.CLOSED) return Effect.void
  return Effect.callback<void>((resume) => {
    const closed = () => resume(Effect.void)
    ws.addEventListener("close", closed, { once: true })
    ws.close(code)
    return Effect.sync(() => ws.removeEventListener("close", closed))
  }).pipe(
    Effect.timeoutOption(CLOSE_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.sync(() => {
            logEvent("fluxer.close_timed_out", { after: CLOSE_TIMEOUT }, "warn")
          }),
        onSome: () => Effect.void,
      }),
    ),
  )
}

function handleEffect(
  session: Session,
  connection: Connection,
  event: SocketEvent,
): Effect.Effect<Ending | undefined, never, Scope.Scope> {
  return Effect.gen(function* () {
    if (event.kind === "message")
      return yield* frameEffect(session, connection, event.data)
    if (event.kind === "close") {
      // A close reason is Fluxer's protocol text, never message content.
      logEvent(
        "fluxer.socket_closed",
        { code: event.code, reason: event.reason },
        "warn",
      )
      return closed(event.code, event.reason)
    }
    if (event.kind === "error") {
      // A close event follows, which ends the socket.
      logEvent("fluxer.socket_error", { error: event.error }, "warn")
      return undefined
    }
    if (event.kind === "stalled") {
      if (connection.established) return undefined
      logEvent("fluxer.socket_stalled", { after: START_TIMEOUT }, "warn")
      return DROPPED
    }
    // A beat. Fluxer gives up on a socket 45 seconds after the last
    // acknowledgement, so an unanswered beat means this one is already dead.
    if (!connection.acked) {
      logEvent("fluxer.heartbeat_missed", {}, "warn")
      return DROPPED
    }
    connection.acked = false
    send(connection, heartbeat(session))
    return undefined
  })
}

function closed(code: number, reason: string): Ending {
  return { kind: "closed", code, reason }
}

function frameEffect(
  session: Session,
  connection: Connection,
  data: unknown,
): Effect.Effect<Ending | undefined, never, Scope.Scope> {
  return Effect.gen(function* () {
    if (typeof data !== "string") {
      dropFrame("binary")
      return undefined
    }
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(data),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))
    const payload = decode(GatewayPayload, parsed)
    if (payload === undefined) {
      dropFrame("malformed")
      return undefined
    }
    if (payload.op === Opcode.Dispatch)
      return yield* dispatchEffect(session, connection, payload)
    if (payload.op === Opcode.HeartbeatAck) {
      connection.acked = true
      return undefined
    }
    if (payload.op === Opcode.Heartbeat) {
      // Asked for one now, on top of the schedule.
      send(connection, heartbeat(session))
      return undefined
    }
    if (payload.op === Opcode.Hello)
      return yield* helloEffect(session, connection, payload.d)
    if (payload.op === Opcode.Reconnect) {
      logEvent("fluxer.socket_reconnect_requested")
      return DROPPED
    }
    if (payload.op === Opcode.InvalidSession) {
      logEvent("fluxer.session_invalid", {}, "warn")
      return INVALID
    }
    // Fluxer may add opcodes. One this client does not know changes nothing.
    logEvent("fluxer.frame_dropped", { reason: "opcode", op: payload.op })
    return undefined
  })
}

/** Starts the heartbeat, then identifies, or resumes a session it still has. */
function helloEffect(
  session: Session,
  connection: Connection,
  d: unknown,
): Effect.Effect<Ending | undefined, never, Scope.Scope> {
  return Effect.gen(function* () {
    const hello = decode(Hello, d)
    if (hello === undefined || connection.beating) {
      dropFrame("hello")
      return undefined
    }
    connection.beating = true
    yield* Effect.sleep(hello.heartbeat_interval).pipe(
      Effect.andThen(Queue.offer(connection.events, { kind: "beat" })),
      Effect.forever,
      Effect.forkScoped,
    )
    if (session.id === undefined || session.seq === null) {
      send(connection, {
        op: Opcode.Identify,
        d: {
          token: session.token,
          properties: IDENTIFY_PROPERTIES,
          ignored_events: IGNORED_EVENTS,
        },
      })
      return undefined
    }
    send(connection, {
      op: Opcode.Resume,
      d: { token: session.token, session_id: session.id, seq: session.seq },
    })
    return undefined
  })
}

function dispatchEffect(
  session: Session,
  connection: Connection,
  payload: GatewayPayload,
): Effect.Effect<Ending | undefined> {
  return Effect.gen(function* () {
    const t = payload.t
    const s = payload.s
    if (typeof t !== "string" || typeof s !== "number") {
      dropFrame("dispatch")
      return undefined
    }
    if (t === "READY") {
      const ready = decode(Ready, payload.d)
      if (ready === undefined) {
        dropFrame("ready")
        return undefined
      }
      session.id = ready.session_id
      established(session, connection, false)
    }
    if (t === "RESUMED") established(session, connection, true)
    yield* Effect.try({
      try: () => session.onDispatch({ t, d: payload.d, s }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          logEvent(
            "fluxer.dispatch_failed",
            { t, error: errorKind(cause) },
            "error",
          )
        }),
      ),
    )
    // Only now is it processed: a heartbeat acknowledges it for good.
    session.seq = s
    if (t === "READY") yield* Deferred.succeed(session.ready, undefined)
    return undefined
  })
}

function established(
  session: Session,
  connection: Connection,
  resumed: boolean,
): void {
  connection.established = true
  session.failures = 0
  logEvent("fluxer.socket_ready", { resumed })
}

function heartbeat(session: Session) {
  return { op: Opcode.Heartbeat, d: session.seq }
}

/** A socket that is no longer open gets nothing; its close is queued. */
function send(connection: Connection, payload: { op: number; d: unknown }) {
  if (connection.ws.readyState !== WebSocket.OPEN) return
  connection.ws.send(JSON.stringify(payload))
}

/** The reason only: a frame can hold message content. */
function dropFrame(reason: string): void {
  logEvent("fluxer.frame_dropped", { reason }, "warn")
}
