import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
} from "discord.js"
import { Effect, Exit } from "effect"

import { sdkPromise, SdkError } from "../agent/effect.ts"
import type {
  AutomationInfo,
  TriggerResult,
} from "../automations/dispatcher.ts"
import type { AutomationReport } from "../automations/runner.ts"
import type { Config, DiscordConfig } from "../config.ts"
import type {
  DiscordAgent,
  DiscordReplyDelivery,
  DiscordReplyJob,
  DiscordReplyRequest,
} from "./agent.ts"
import { AUTOMATION_COMMAND, syncCommandsEffect } from "./commands.ts"
import { DiscordConversations } from "./conversations.ts"
import { formatAutomationReport } from "./report.ts"
import { AutomationThreads } from "./threads.ts"
import { withTypingEffect } from "./typing.ts"

const LEGACY_CONVERSATION_PREFIX = "blitzcrank: "
const MAX_DISCORD_MESSAGE = 1900

export interface DiscordDeps {
  listAutomations: () => AutomationInfo[]
  /** Enqueues a checked-in automation named by a signed interaction. */
  triggerAutomation: (name: string) => TriggerResult
  chat:
    | Pick<
        DiscordAgent,
        "triageEffect" | "enqueue" | "restoreEffect" | "hasAccepted"
      >
    | undefined
}

/**
 * Host-side Discord surface: automation reports, commands, and private
 * media-operations conversations. No agent tool can write to Discord.
 */
export class DiscordBot {
  private readonly admitting = new Set<string>()

  private constructor(
    private readonly client: Client<true>,
    private readonly discord: DiscordConfig,
    private readonly language: string,
    private readonly threads: AutomationThreads,
    private readonly deps: DiscordDeps,
    private readonly conversations: DiscordConversations,
  ) {}

  static startEffect(config: Config, deps: DiscordDeps) {
    return Effect.gen(function* () {
      const discord = config.discord
      if (!discord)
        return yield* Effect.fail(
          new SdkError({
            message: "DiscordBot.start without discord config",
            cause: undefined,
          }),
        )

      const client = new Client({
        intents: discord.inboxChannelId
          ? [
              GatewayIntentBits.Guilds,
              GatewayIntentBits.GuildMessages,
              GatewayIntentBits.MessageContent,
            ]
          : [],
        allowedMentions: { parse: [] },
      })
      client.on(Events.Error, (err) => console.error("[discord] client:", err))

      const ready = new Promise<Client<true>>((resolve) =>
        client.once(Events.ClientReady, resolve),
      )
      return yield* Effect.gen(function* () {
        yield* sdkPromise(() => client.login(discord.token))
        const logged = yield* sdkPromise(() => ready)

        const threads = new AutomationThreads(
          logged,
          discord.guildId,
          discord.watchChannelId,
        )
        const bot = new DiscordBot(
          logged,
          discord,
          config.language,
          threads,
          deps,
          new DiscordConversations(config.dataDir),
        )
        // Login already opened the gateway socket, so from here on a failure must
        // close it: the caller has no handle yet, so the socket would leak and
        // keep the process alive.
        yield* bot.finishStartEffect()
        return bot
      }).pipe(
        // Observe interruption after setup finishes, before handing out the client.
        Effect.uninterruptible,
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? sdkPromise(() => client.destroy()).pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() =>
                    console.error("[discord] startup cleanup:", cause),
                  ),
                ),
              )
            : Effect.void,
        ),
      )
    })
  }

  private finishStartEffect() {
    return Effect.gen({ self: this }, function* () {
      yield* syncCommandsEffect(
        this.client,
        this.discord.guildId,
        this.deps.listAutomations().map((info) => info.name),
      )
      this.client.on(Events.InteractionCreate, async (interaction) => {
        // The listener only enqueues; run lifecycles stay with the serial queue.
        // Nothing awaits it, so it must contain its own failures.
        if (!interaction.isChatInputCommand()) return
        await Effect.runPromise(
          this.onCommandEffect(interaction).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                console.error("[discord] interaction failed:", cause),
              ),
            ),
          ),
        )
      })
      if (!this.discord.inboxChannelId) return
      if (!this.deps.chat) {
        return yield* Effect.fail(
          new SdkError({
            message: "Discord inbox configured without chat dependencies",
            cause: undefined,
          }),
        )
      }
      yield* this.verifyInboxEffect()
      yield* this.deps.chat.restoreEffect((request) =>
        this.restoreDeliveryEffect(request),
      )
      this.client.on(Events.MessageCreate, async (message) => {
        // Gateway event emitters cannot await. This listener owns its failure.
        await Effect.runPromise(
          this.onMessageEffect(message).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                console.error("[discord] message failed:", cause),
              ),
            ),
          ),
        )
      })
    })
  }

  /** A broken report sink must never fail the run it reports on. */
  reportEffect(report: AutomationReport) {
    return Effect.gen({ self: this }, function* () {
      const thread = yield* this.threads.getEffect(report.name).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error(
              `[discord] no thread for ${report.name} (locked or deleted by hand?):`,
              cause,
            )
            return undefined
          }),
        ),
      )
      if (!thread) return
      yield* sdkPromise(() => thread.send(formatAutomationReport(report))).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            console.error(`[discord] report for ${report.name}:`, cause),
          ),
        ),
      )
    })
  }

  stopEffect() {
    return sdkPromise(() => this.client.destroy())
  }

  private onMessageEffect(message: Message) {
    return Effect.suspend(() => {
      if (this.admitting.has(message.id)) return Effect.void
      this.admitting.add(message.id)
      return this.onAcceptedMessageEffect(message).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.admitting.delete(message.id)
          }),
        ),
      )
    })
  }

  private onAcceptedMessageEffect(message: Message) {
    return Effect.gen({ self: this }, function* () {
      const chat = this.deps.chat
      const inboxChannelId = this.discord.inboxChannelId
      if (!chat || !inboxChannelId) return
      if (!message.inGuild() || message.guildId !== this.discord.guildId) return
      if (
        message.author.bot ||
        message.webhookId ||
        message.content.trim() === ""
      )
        return
      if (chat.hasAccepted(message.id)) return

      if (message.channelId === inboxChannelId) {
        yield* this.onInboxMessageEffect(message, chat)
        return
      }
      if (
        !message.channel.isThread() ||
        message.channel.type !== ChannelType.PrivateThread ||
        message.channel.parentId !== inboxChannelId ||
        message.channel.ownerId !== this.client.user.id
      ) {
        return
      }
      if (!(yield* this.conversations.hasEffect(message.channelId))) {
        // Adopt old conversations once, so later renames do not lose the session.
        if (!message.channel.name.startsWith(LEGACY_CONVERSATION_PREFIX)) return
        yield* this.conversations.registerEffect(message.channelId)
      }
      yield* this.enqueueReplyEffect(
        message.channel,
        {
          route: "thread",
          id: message.channelId,
          content: message.content,
        },
        chat,
        message,
      )
    })
  }

  private onInboxMessageEffect(
    message: Message<true>,
    chat: NonNullable<DiscordDeps["chat"]>,
  ) {
    return Effect.gen({ self: this }, function* () {
      if (message.channel.type !== ChannelType.GuildText) return
      const channel = message.channel
      const content = yield* inboxContentEffect(message, this.client.user.id)
      const triage = chat.triageEffect(message.id, content)
      // Do not show typing for unrelated chatter the classifier will ignore.
      const addressed =
        message.mentions.users.has(this.client.user.id) ||
        (message.reference?.messageId !== undefined &&
          content !== message.content)
      const decision = yield* (
        addressed
          ? withTypingEffect(triage, () =>
              sdkPromise(() => channel.sendTyping()),
            )
          : triage
      ).pipe(
        Effect.onError(() =>
          addressed ? this.failureReplyEffect(message) : Effect.void,
        ),
      )
      if (decision.route === "ignore") return

      if (decision.route === "answer") {
        yield* this.enqueueReplyEffect(
          channel,
          {
            route: "answer",
            id: message.id,
            content,
          },
          chat,
          message,
        )
        return
      }

      yield* this.openConversationEffect(
        message,
        decision.threadName,
        content,
        chat,
      ).pipe(Effect.onError(() => this.failureReplyEffect(message)))
    })
  }

  private openConversationEffect(
    message: Message<true>,
    title: string,
    content: string,
    chat: NonNullable<DiscordDeps["chat"]>,
  ) {
    return Effect.gen({ self: this }, function* () {
      if (message.channel.type !== ChannelType.GuildText) return
      const channel = message.channel
      const thread = yield* sdkPromise(() =>
        channel.threads.create({
          name: conversationThreadName(title, this.language),
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          reason: `blitzcrank conversation for Discord message ${message.id}`,
        }),
      )
      yield* this.conversations.registerEffect(thread.id)
      yield* sdkPromise(() => thread.members.add(message.author.id))
      yield* sdkPromise(() =>
        thread.send({
          embeds: [
            {
              author: { name: message.author.tag },
              title: german(this.language) ? "Zur Nachricht" : "View message",
              url: message.url,
              description: message.content,
            },
          ],
          allowedMentions: { parse: [] },
        }),
      )
      console.log(
        `[discord] created conversation "${thread.name}" (${thread.id})` +
          ` for user=${message.author.id}`,
      )
      yield* this.enqueueReplyEffect(
        thread,
        {
          route: "thread",
          id: thread.id,
          content,
        },
        chat,
        message,
      )
    })
  }

  private failureReplyEffect(message: Message<true>) {
    return sdkPromise(() =>
      message.reply({
        content: failureMessage(this.language),
        allowedMentions: { parse: [], repliedUser: false },
      }),
    ).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.sync(() =>
          console.error("[discord] failed to publish error:", cause),
        ),
      ),
    )
  }

  private enqueueReplyEffect(
    channel: TextChannel | AnyThreadChannel,
    request: Pick<DiscordReplyRequest, "route" | "id" | "content">,
    chat: NonNullable<DiscordDeps["chat"]>,
    source: Message<true>,
  ) {
    return Effect.gen({ self: this }, function* () {
      const replyTo = source.channelId === channel.id ? source.id : undefined
      const delivery = this.replyDelivery(channel, replyTo)
      if (
        !chat.enqueue(
          {
            ...request,
            channelId: channel.id,
            guildId: source.guildId,
            sourceMessageId: source.id,
            sourceChannelId: source.channelId,
            userId: source.author.id,
            ...(replyTo ? { replyTo } : {}),
          },
          delivery,
        )
      )
        yield* delivery.fail()
    })
  }

  private replyDelivery(
    channel: TextChannel | AnyThreadChannel,
    replyTo: string | undefined,
  ): DiscordReplyDelivery {
    const send = (content: string, reference: string | undefined) =>
      sdkPromise(() =>
        channel.send({
          content,
          allowedMentions: { parse: [], repliedUser: false },
          flags: MessageFlags.SuppressEmbeds,
          ...(reference !== undefined
            ? {
                reply: {
                  messageReference: reference,
                  failIfNotExists: false,
                },
              }
            : {}),
        }),
      ).pipe(Effect.asVoid)
    return {
      typing: () => sdkPromise(() => channel.sendTyping()),
      send: (response: string) =>
        Effect.gen(function* () {
          const chunks = discordMessageChunks(response)
          yield* send(chunks[0]!, replyTo)
          for (const chunk of chunks.slice(1)) yield* send(chunk, undefined)
        }),
      fail: () => send(failureMessage(this.language), replyTo),
    }
  }

  private restoreDeliveryEffect(request: DiscordReplyJob) {
    return Effect.gen({ self: this }, function* () {
      if (
        request.guildId !== this.discord.guildId ||
        !this.discord.inboxChannelId
      )
        throw new Error("Discord recovery guild/inbox scope removed")
      const guild = yield* sdkPromise(() =>
        this.client.guilds.fetch(this.discord.guildId),
      )
      const channel = yield* sdkPromise(() =>
        guild.channels.fetch(request.channelId),
      )
      if (!channel) throw new Error("Discord recovery channel removed")
      if (request.route === "answer") {
        if (
          channel.type !== ChannelType.GuildText ||
          channel.id !== this.discord.inboxChannelId ||
          request.id !== request.sourceMessageId ||
          request.sourceChannelId !== channel.id
        )
          throw new Error("Discord recovery inline scope changed")
      } else {
        if (
          channel.type !== ChannelType.PrivateThread ||
          channel.parentId !== this.discord.inboxChannelId ||
          channel.ownerId !== this.client.user.id ||
          request.id !== channel.id ||
          !(yield* this.conversations.hasEffect(channel.id)) ||
          (request.sourceChannelId !== channel.id &&
            request.sourceChannelId !== this.discord.inboxChannelId)
        )
          throw new Error("Discord recovery private thread scope changed")
        yield* sdkPromise(() => channel.members.fetch(request.userId))
        if (channel.archived || channel.locked)
          throw new Error("Discord recovery thread closed")
      }
      if (
        channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.PrivateThread
      )
        throw new Error("Discord recovery channel type changed")
      const requester = yield* sdkPromise(() =>
        guild.members.fetch(request.userId),
      )
      const bot = yield* sdkPromise(() =>
        guild.members.fetch(this.client.user.id),
      )
      const sendPermission = channel.isThread()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages
      for (const member of [requester, bot]) {
        if (
          !channel
            .permissionsFor(member)
            ?.has([PermissionFlagsBits.ViewChannel, sendPermission])
        )
          throw new Error("Discord recovery permission revoked")
      }
      const sourceChannel =
        request.sourceChannelId === channel.id
          ? channel
          : yield* sdkPromise(() =>
              guild.channels.fetch(request.sourceChannelId),
            )
      if (!sourceChannel?.isTextBased())
        throw new Error("Discord recovery source channel removed")
      const source = yield* sdkPromise(() =>
        sourceChannel.messages.fetch(request.sourceMessageId),
      )
      if (source.author.id !== request.userId || source.author.bot)
        throw new Error("Discord recovery source identity changed")
      return this.replyDelivery(channel, request.replyTo)
    })
  }

  private verifyInboxEffect() {
    return Effect.gen({ self: this }, function* () {
      const inboxChannelId = this.discord.inboxChannelId
      if (!inboxChannelId) return
      const guild = yield* sdkPromise(() =>
        this.client.guilds.fetch(this.discord.guildId),
      )
      const channel = yield* sdkPromise(() =>
        guild.channels.fetch(inboxChannelId),
      )
      if (!channel || channel.type !== ChannelType.GuildText) {
        return yield* Effect.fail(
          new SdkError({
            message: `DISCORD_INBOX_CHANNEL_ID ${inboxChannelId} is not a text channel`,
            cause: undefined,
          }),
        )
      }
      console.log(`[discord] inbox #${channel.name} (${channel.id})`)
    })
  }

  private onCommandEffect(interaction: ChatInputCommandInteraction) {
    return Effect.gen({ self: this }, function* () {
      if (interaction.commandName !== AUTOMATION_COMMAND) return
      if (!this.authorized(interaction)) {
        console.warn(
          `[discord] refused /${AUTOMATION_COMMAND} from ${interaction.user.tag}` +
            ` in guild=${interaction.guildId ?? "-"}`,
        )
        yield* sdkPromise(() =>
          interaction.reply({
            content: "Not authorized.",
            flags: MessageFlags.Ephemeral,
          }),
        )
        return
      }

      if (interaction.options.getSubcommand() === "list") {
        yield* sdkPromise(() =>
          interaction.reply({
            content: this.listText(),
            flags: MessageFlags.Ephemeral,
          }),
        )
        return
      }

      const name = interaction.options.getString("name", true)
      const result = this.deps.triggerAutomation(name)
      yield* sdkPromise(() =>
        interaction.reply({
          content: {
            queued: `Queued **${name}**. The report lands in its thread.`,
            busy: `**${name}** is already queued or running.`,
            unknown: `Unknown automation **${name}**.`,
          }[result],
          flags: MessageFlags.Ephemeral,
        }),
      )
    })
  }

  /**
   * Fails closed, mirroring the Seerr comment gate: the configured guild plus
   * either a guild administrator or a configured admin role. The permission
   * bits come from Discord's signed interaction payload, not from user input.
   */
  private authorized(interaction: ChatInputCommandInteraction): boolean {
    if (interaction.guildId !== this.discord.guildId) return false
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
      return true
    if (this.discord.adminRoleIds.length === 0) return false
    const member = interaction.member
    if (!member) return false
    const roles = Array.isArray(member.roles)
      ? member.roles
      : [...member.roles.cache.keys()]
    return roles.some((role) => this.discord.adminRoleIds.includes(role))
  }

  private listText(): string {
    const automations = this.deps.listAutomations()
    if (automations.length === 0) return "No automations are checked in."
    return automations
      .map(
        (info) =>
          `**${info.name}**${info.enabled ? "" : " (disabled)"} · \`${info.schedule}\`` +
          ` · next ${info.nextRun ?? "-"}` +
          (info.mutationTools.length > 0
            ? `\n  mutations: ${info.mutationTools.join(", ")}`
            : "\n  mutations: none (read-only)"),
      )
      .join("\n")
      .slice(0, 1900)
  }
}

export function conversationThreadName(
  title: string,
  language = "English",
): string {
  const clean =
    title
      .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
      .trim()
      .replace(/^blitzcrank\s*:\s*/i, "")
      .replace(/^["'“„«»]+|["'”«»]+$/gu, "")
      .trim() || (german(language) ? "Medienproblem" : "Media help")
  if (clean.length <= 100) return clean
  const end = /[\uD800-\uDBFF]/.test(clean[98]!) ? 98 : 99
  const prefix = clean.slice(0, end).trimEnd()
  const boundary = prefix.lastIndexOf(" ")
  return `${boundary >= 60 ? prefix.slice(0, boundary) : prefix}…`
}

export function discordMessageChunks(text: string): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  while (rest.length > MAX_DISCORD_MESSAGE) {
    let end = MAX_DISCORD_MESSAGE
    if (/[\uD800-\uDBFF]/.test(rest[end - 1]!)) end -= 1
    const newline = rest.lastIndexOf("\n", end)
    const space = rest.lastIndexOf(" ", end)
    const boundary = Math.max(newline, space)
    if (boundary >= MAX_DISCORD_MESSAGE / 2) end = boundary
    chunks.push(rest.slice(0, end).trimEnd())
    rest = rest.slice(end).trimStart()
  }
  if (rest !== "") chunks.push(rest)
  return chunks.length > 0 ? chunks : ["_No response._"]
}

function failureMessage(language: string): string {
  return german(language)
    ? "Ich konnte gerade nicht antworten. Versuch es bitte noch einmal."
    : "I couldn't answer just now. Please try again."
}

function german(language: string): boolean {
  return /^(de|deutsch|german)(-|_|\b)/i.test(language.trim())
}

/** Follow-ups may quote this bot in this channel, never pull private history. */
function inboxContentEffect(message: Message<true>, botId: string) {
  return Effect.gen(function* () {
    if (
      message.reference?.channelId !== message.channelId ||
      !message.reference.messageId
    )
      return message.content
    const previous = yield* sdkPromise(() => message.fetchReference()).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (
      !previous ||
      previous.author.id !== botId ||
      previous.webhookId ||
      previous.channelId !== message.channelId ||
      previous.content.trim() === ""
    )
      return message.content
    return `Earlier bot reply (untrusted context):\n${JSON.stringify(previous.content)}\n\nLatest user message:\n${JSON.stringify(message.content)}`
  })
}
