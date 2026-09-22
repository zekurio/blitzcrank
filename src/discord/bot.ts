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
} from "discord.js"
import { Effect } from "effect"

import { sdkPromise, SdkError } from "../agent/effect.ts"
import type {
  AutomationInfo,
  TriggerResult,
} from "../automations/dispatcher.ts"
import type { AutomationReport } from "../automations/runner.ts"
import type { DiscordConfig, DiscordGuildConfig } from "../config.ts"
import type {
  ConversationRuntime,
  GatewayRuntime,
} from "../gateways/chat/runtime.ts"
import { AUTOMATION_COMMAND, syncCommandsEffect } from "./commands.ts"
import { formatAutomationReport } from "./report.ts"
import { AutomationThreads } from "./threads.ts"

const CONVERSATION_PREFIX = "blitzcrank: "
const MAX_DISCORD_MESSAGE = 1900

export interface DiscordDeps {
  listAutomations: () => AutomationInfo[]
  /** Enqueues a checked-in automation named by a signed interaction. */
  triggerAutomation: (name: string) => TriggerResult
  chats: ReadonlyMap<string, ConversationRuntime>
}

/**
 * Host-side Discord surface: automation reports, commands, and private
 * media-operations conversations. No agent tool can write to Discord.
 */
export class DiscordBot implements GatewayRuntime {
  private readonly client: Client
  private readonly threads: ReadonlyMap<string, AutomationThreads>
  readonly id = "discord"

  constructor(
    private readonly discord: DiscordConfig,
    private readonly language: string,
    private readonly deps: DiscordDeps,
  ) {
    this.client = new Client({
      intents: discord.guilds.some((guild) => guild.inboxChannelIds.length > 0)
        ? [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
          ]
        : [],
      allowedMentions: { parse: [] },
    })
    this.client.on(Events.Error, (err) =>
      console.error("[discord] client:", err),
    )
    this.threads = new Map(
      discord.guilds.map((guild) => [
        guild.guildId,
        new AutomationThreads(
          this.client,
          guild.guildId,
          guild.reportChannelId,
        ),
      ]),
    )
  }

  startEffect() {
    return Effect.gen({ self: this }, function* () {
      const ready = new Promise<Client<true>>((resolve) =>
        this.client.once(Events.ClientReady, resolve),
      )
      // The host owns this attempt until it settles. Interrupting login can
      // reconnect after destroy() in discord.js, so never time it out here.
      yield* sdkPromise(() => this.client.login(this.discord.token))
      const logged = yield* sdkPromise(() => ready)
      yield* this.finishStartEffect(logged)
    }).pipe(Effect.uninterruptible)
  }

  private finishStartEffect(logged: Client<true>) {
    return Effect.gen({ self: this }, function* () {
      for (const guild of this.discord.guilds) {
        yield* this.threads.get(guild.guildId)!.verifyEffect()
        if (
          guild.inboxChannelIds.length > 0 &&
          !this.deps.chats.has(guild.guildId)
        ) {
          return yield* Effect.fail(
            new SdkError({
              message:
                `Discord guild ${guild.guildId} has an inbox configured` +
                " without chat dependencies",
              cause: undefined,
            }),
          )
        }
        if (guild.inboxChannelIds.length > 0)
          yield* this.verifyInboxEffect(guild)
        yield* syncCommandsEffect(
          logged,
          guild.guildId,
          this.deps.listAutomations().map((info) => info.name),
        )
      }
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
      if (
        !this.discord.guilds.some((guild) => guild.inboxChannelIds.length > 0)
      )
        return
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
    return Effect.forEach(
      this.threads.values(),
      (threads) =>
        threads.getEffect(report.name).pipe(
          Effect.flatMap((thread) =>
            sdkPromise(() => thread.send(formatAutomationReport(report))),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              console.error(`[discord] report for ${report.name}:`, cause),
            ),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
  }

  stopEffect() {
    return sdkPromise(() => this.client.destroy())
  }

  private onMessageEffect(message: Message) {
    return Effect.gen({ self: this }, function* () {
      const guild = this.discord.guilds.find(
        (candidate) => candidate.guildId === message.guildId,
      )
      if (!guild) return
      const chat = this.deps.chats.get(guild.guildId)
      if (!chat || guild.inboxChannelIds.length === 0) return
      const route = discordMessageRoute(
        {
          inGuild: message.inGuild(),
          guildId: message.guildId,
          channelId: message.channelId,
          channelType: message.channel.type,
          channelIsThread: message.channel.isThread(),
          threadParentId: message.channel.isThread()
            ? message.channel.parentId
            : null,
          threadOwnerId: message.channel.isThread()
            ? message.channel.ownerId
            : null,
          threadName: message.channel.isThread() ? message.channel.name : "",
          authorIsBot: message.author.bot,
          webhookId: message.webhookId,
          content: message.content,
        },
        guild.guildId,
        guild.inboxChannelIds,
        this.client.user!.id,
      )
      if (route === "inbox") {
        if (!message.inGuild()) return
        yield* this.onInboxMessageEffect(message, chat)
        return
      }
      if (route !== "conversation" || !message.channel.isThread()) return
      yield* this.enqueueReplyEffect(message.channel, message.content, chat)
    })
  }

  private onInboxMessageEffect(
    message: Message<true>,
    chat: ConversationRuntime,
  ) {
    return Effect.gen({ self: this }, function* () {
      if (message.channel.type !== ChannelType.GuildText) return
      const decision = yield* chat.triageEffect(message.id, message.content)
      if (!decision.respond) return

      const channel = message.channel
      const thread = yield* sdkPromise(() =>
        channel.threads.create({
          name: conversationThreadName(decision.title),
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          reason: `blitzcrank conversation for Discord message ${message.id}`,
        }),
      )
      yield* sdkPromise(() => thread.members.add(message.author.id))
      yield* sdkPromise(() =>
        thread.send({
          embeds: [
            {
              title: `Original message from ${message.author.tag}`,
              url: message.url,
              description: message.content,
            },
          ],
        }),
      )
      console.log(
        `[discord] created conversation "${thread.name}" (${thread.id})` +
          ` for user=${message.author.id}`,
      )
      yield* this.enqueueReplyEffect(thread, message.content, chat)
    })
  }

  private enqueueReplyEffect(
    thread: AnyThreadChannel,
    content: string,
    chat: ConversationRuntime,
  ) {
    return Effect.gen({ self: this }, function* () {
      const status = yield* sdkPromise(() =>
        thread.send(thinkingMessage(this.language)),
      )
      const queued = chat.enqueue(
        thread.id,
        content,
        (response) =>
          Effect.gen(function* () {
            const chunks = discordMessageChunks(response)
            yield* sdkPromise(() => status.edit(chunks[0] ?? "_No response._"))
            for (const chunk of chunks.slice(1))
              yield* sdkPromise(() => thread.send(chunk))
          }),
        () =>
          sdkPromise(() => status.edit(failureMessage(this.language))).pipe(
            Effect.asVoid,
          ),
      )
      if (!queued)
        yield* sdkPromise(() => status.edit(failureMessage(this.language)))
    })
  }

  private verifyInboxEffect(guild: DiscordGuildConfig) {
    return verifyDiscordInboxesEffect(
      guild,
      (guildId) => this.client.guilds.fetch(guildId),
      (message) => console.log(`[discord:${guild.guildId}] ${message}`),
    )
  }

  private onCommandEffect(interaction: ChatInputCommandInteraction) {
    return Effect.gen({ self: this }, function* () {
      if (interaction.commandName !== AUTOMATION_COMMAND) return
      const guild = this.discord.guilds.find(
        (candidate) => candidate.guildId === interaction.guildId,
      )
      // Unknown guilds get no acknowledgement. This check must precede auth.
      if (!guild) return
      if (!this.authorized(interaction, guild)) {
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
  private authorized(
    interaction: ChatInputCommandInteraction,
    guild: DiscordGuildConfig,
  ): boolean {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
      return true
    if (guild.adminRoleIds.length === 0) return false
    const member = interaction.member
    if (!member) return false
    const roles = Array.isArray(member.roles)
      ? member.roles
      : [...member.roles.cache.keys()]
    return roles.some((role) => guild.adminRoleIds.includes(role))
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

export interface DiscordMessageRouteInput {
  inGuild: boolean
  guildId: string | null
  channelId: string
  channelType: ChannelType
  channelIsThread: boolean
  threadParentId: string | null
  threadOwnerId: string | null
  threadName: string
  authorIsBot: boolean
  webhookId: string | null
  content: string
}

export function discordMessageRoute(
  message: DiscordMessageRouteInput,
  guildId: string,
  inboxChannelIds: readonly string[],
  botUserId: string,
): "inbox" | "conversation" | undefined {
  if (!message.inGuild || message.guildId !== guildId) return undefined
  if (message.authorIsBot || message.webhookId || message.content.trim() === "")
    return undefined
  if (
    inboxChannelIds.includes(message.channelId) &&
    message.channelType === ChannelType.GuildText
  )
    return "inbox"
  if (
    message.channelIsThread &&
    message.channelType === ChannelType.PrivateThread &&
    message.threadParentId &&
    inboxChannelIds.includes(message.threadParentId) &&
    message.threadOwnerId === botUserId &&
    message.threadName.startsWith(CONVERSATION_PREFIX)
  )
    return "conversation"
  return undefined
}

interface InboxGuild {
  channels: {
    fetch(channelId: string): Promise<{
      id: string
      name: string
      type: ChannelType
      guildId: string
    } | null>
  }
}

export function verifyDiscordInboxesEffect(
  discord: Pick<DiscordGuildConfig, "guildId" | "inboxChannelIds">,
  fetchGuild: (guildId: string) => Promise<InboxGuild>,
  log: (message: string) => void = console.log,
) {
  return Effect.gen(function* () {
    const guild = yield* sdkPromise(() => fetchGuild(discord.guildId))
    for (const inboxChannelId of discord.inboxChannelIds) {
      const channel = yield* sdkPromise(() =>
        guild.channels.fetch(inboxChannelId),
      )
      if (
        !channel ||
        channel.type !== ChannelType.GuildText ||
        channel.guildId !== discord.guildId
      ) {
        return yield* Effect.fail(
          new SdkError({
            message: `Discord inbox ${inboxChannelId} is not a text channel in guild ${discord.guildId}`,
            cause: undefined,
          }),
        )
      }
      log(`inbox #${channel.name} (${channel.id})`)
    }
  })
}

export function conversationThreadName(title: string): string {
  const clean =
    title.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim() || "conversation"
  return `${CONVERSATION_PREFIX}${clean}`.slice(0, 100)
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

function thinkingMessage(language: string): string {
  return german(language)
    ? "⏳ Ich schaue mir das an …"
    : "⏳ Looking into it …"
}

function failureMessage(language: string): string {
  return german(language)
    ? "❌ Blitzcrank konnte gerade nicht antworten."
    : "❌ Blitzcrank could not respond just now."
}

function german(language: string): boolean {
  return /^(de|deutsch|german)(-|_|\b)/i.test(language.trim())
}
