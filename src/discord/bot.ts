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
import { Effect, Exit } from "effect"

import { sdkPromise, SdkError } from "../agent/effect.ts"
import type {
  AutomationInfo,
  TriggerResult,
} from "../automations/dispatcher.ts"
import type { AutomationReport } from "../automations/runner.ts"
import type { Config, DiscordConfig } from "../config.ts"
import type { DiscordAgent } from "./agent.ts"
import { AUTOMATION_COMMAND, syncCommandsEffect } from "./commands.ts"
import { formatAutomationReport } from "./report.ts"
import { AutomationThreads } from "./threads.ts"

const CONVERSATION_PREFIX = "blitzcrank: "
const MAX_DISCORD_MESSAGE = 1900

export interface DiscordDeps {
  listAutomations: () => AutomationInfo[]
  /** Enqueues a checked-in automation named by a signed interaction. */
  triggerAutomation: (name: string) => TriggerResult
  chat: DiscordAgent | undefined
}

/**
 * Host-side Discord surface: automation reports, commands, and private
 * media-operations conversations. No agent tool can write to Discord.
 */
export class DiscordBot {
  private constructor(
    private readonly client: Client<true>,
    private readonly discord: DiscordConfig,
    private readonly language: string,
    private readonly threads: AutomationThreads,
    private readonly deps: DiscordDeps,
  ) {}

  static start(config: Config, deps: DiscordDeps): Promise<DiscordBot> {
    return Effect.runPromise(this.startEffect(config, deps))
  }
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
        )
        // Login already opened the gateway socket, so from here on a failure must
        // close it: the caller has no handle yet, so the socket would leak and
        // keep the process alive.
        yield* bot.finishStartEffect()
        return bot
      }).pipe(
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
    }).pipe(Effect.uninterruptible)
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
  report(report: AutomationReport): Promise<void> {
    return Effect.runPromise(this.reportEffect(report))
  }
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

  stop(): Promise<void> {
    return Effect.runPromise(this.stopEffect())
  }
  stopEffect() {
    return sdkPromise(() => this.client.destroy())
  }

  private onMessageEffect(message: Message) {
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

      if (message.channelId === inboxChannelId) {
        yield* this.onInboxMessageEffect(message, chat)
        return
      }
      if (
        !message.channel.isThread() ||
        message.channel.type !== ChannelType.PrivateThread ||
        message.channel.parentId !== inboxChannelId ||
        message.channel.ownerId !== this.client.user.id ||
        !message.channel.name.startsWith(CONVERSATION_PREFIX)
      ) {
        return
      }
      yield* this.enqueueReplyEffect(message.channel, message.content, chat)
    })
  }

  private onInboxMessageEffect(message: Message<true>, chat: DiscordAgent) {
    return Effect.gen({ self: this }, function* () {
      if (message.channel.type !== ChannelType.GuildText) return
      const decision = yield* chat.triageEffect(message.id, message.content)
      if (!decision.respond) return

      const channel = message.channel
      const thread = yield* sdkPromise(() =>
        channel.threads.create({
          name: conversationThreadName(decision.threadName),
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
    chat: DiscordAgent,
  ) {
    return Effect.gen({ self: this }, function* () {
      const status = yield* sdkPromise(() =>
        thread.send(thinkingMessage(this.language)),
      )
      chat.enqueue(
        thread.id,
        content,
        (response) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const chunks = discordMessageChunks(response)
              yield* sdkPromise(() =>
                status.edit(chunks[0] ?? "_No response._"),
              )
              for (const chunk of chunks.slice(1))
                yield* sdkPromise(() => thread.send(chunk))
            }),
          ),
        () =>
          Effect.runPromise(
            sdkPromise(() => status.edit(failureMessage(this.language))).pipe(
              Effect.asVoid,
            ),
          ),
      )
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
