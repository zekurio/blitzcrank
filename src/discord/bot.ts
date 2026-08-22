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

import type {
  AutomationInfo,
  TriggerResult,
} from "../automations/dispatcher.ts"
import type { AutomationReport } from "../automations/runner.ts"
import type { Config, DiscordConfig } from "../config.ts"
import type { DiscordAgent } from "./agent.ts"
import { AUTOMATION_COMMAND, syncCommands } from "./commands.ts"
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
 * read-only support conversations. No agent tool can write to Discord.
 */
export class DiscordBot {
  private constructor(
    private readonly client: Client<true>,
    private readonly discord: DiscordConfig,
    private readonly language: string,
    private readonly threads: AutomationThreads,
    private readonly deps: DiscordDeps,
  ) {}

  static async start(config: Config, deps: DiscordDeps): Promise<DiscordBot> {
    const discord = config.discord
    if (!discord) throw new Error("DiscordBot.start without discord config")

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
    await client.login(discord.token)
    const logged = await ready

    const threads = new AutomationThreads(
      logged,
      discord.guildId,
      discord.watchChannelId,
    )
    const bot = new DiscordBot(logged, discord, config.language, threads, deps)
    // Login already opened the gateway socket, so from here on a failure must
    // close it: the caller has no handle yet, so the socket would leak and
    // keep the process alive.
    await bot.finishStart().catch(async (cause: unknown) => {
      await logged.destroy()
      throw cause
    })
    return bot
  }

  private async finishStart(): Promise<void> {
    await syncCommands(
      this.client,
      this.discord.guildId,
      this.deps.listAutomations().map((info) => info.name),
    )
    this.client.on(Events.InteractionCreate, async (interaction) => {
      // The listener only enqueues; run lifecycles stay with the serial queue.
      // Nothing awaits it, so it must contain its own failures.
      if (!interaction.isChatInputCommand()) return
      await this.onCommand(interaction).catch((err) => {
        console.error("[discord] interaction failed:", err)
      })
    })
    if (!this.discord.inboxChannelId) return
    if (!this.deps.chat) {
      throw new Error("Discord inbox configured without chat dependencies")
    }
    await this.verifyInbox()
    this.client.on(Events.MessageCreate, async (message) => {
      // Gateway event emitters cannot await. This listener owns its failure.
      await this.onMessage(message).catch((err) => {
        console.error("[discord] message failed:", err)
      })
    })
  }

  /** A broken report sink must never fail the run it reports on. */
  async report(report: AutomationReport): Promise<void> {
    const thread = await this.threads
      .get(report.name)
      .catch((cause: unknown) => {
        // A thread a human locked cannot be revived without ManageThreads, which
        // the bot deliberately does not need; say so instead of a bare 403.
        console.error(
          `[discord] no thread for ${report.name}` +
            ` (locked or deleted by hand?):`,
          cause,
        )
        return undefined
      })
    if (!thread) return
    await thread
      .send(formatAutomationReport(report))
      .catch((cause: unknown) => {
        console.error(`[discord] report for ${report.name}:`, cause)
      })
  }

  async stop(): Promise<void> {
    await this.client.destroy()
  }

  private async onMessage(message: Message): Promise<void> {
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
      await this.onInboxMessage(message, chat)
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
    await this.enqueueReply(message.channel, message.content, chat)
  }

  private async onInboxMessage(
    message: Message<true>,
    chat: DiscordAgent,
  ): Promise<void> {
    if (message.channel.type !== ChannelType.GuildText) return
    const decision = await chat.triage(message.id, message.content)
    if (!decision.respond) return

    const thread = await message.channel.threads.create({
      name: conversationThreadName(decision.threadName),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `blitzcrank conversation for Discord message ${message.id}`,
    })
    await thread.members.add(message.author.id)
    await thread.send({
      embeds: [
        {
          title: `Original message from ${message.author.tag}`,
          url: message.url,
          description: message.content,
        },
      ],
    })
    console.log(
      `[discord] created conversation "${thread.name}" (${thread.id})` +
        ` for user=${message.author.id}`,
    )
    await this.enqueueReply(thread, message.content, chat)
  }

  private async enqueueReply(
    thread: AnyThreadChannel,
    content: string,
    chat: DiscordAgent,
  ): Promise<void> {
    const status = await thread.send(thinkingMessage(this.language))
    chat.enqueue(
      thread.id,
      content,
      async (response) => {
        const chunks = discordMessageChunks(response)
        await status.edit(chunks[0] ?? "_No response._")
        for (const chunk of chunks.slice(1)) await thread.send(chunk)
      },
      async () => {
        await status.edit(failureMessage(this.language))
      },
    )
  }

  private async verifyInbox(): Promise<void> {
    const inboxChannelId = this.discord.inboxChannelId
    if (!inboxChannelId) return
    const guild = await this.client.guilds.fetch(this.discord.guildId)
    const channel = await guild.channels.fetch(inboxChannelId)
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(
        `DISCORD_INBOX_CHANNEL_ID ${inboxChannelId} is not a text channel`,
      )
    }
    console.log(`[discord] inbox #${channel.name} (${channel.id})`)
  }

  private async onCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (interaction.commandName !== AUTOMATION_COMMAND) return
    if (!this.authorized(interaction)) {
      console.warn(
        `[discord] refused /${AUTOMATION_COMMAND} from ${interaction.user.tag}` +
          ` in guild=${interaction.guildId ?? "-"}`,
      )
      await interaction.reply({
        content: "Not authorized.",
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    if (interaction.options.getSubcommand() === "list") {
      await interaction.reply({
        content: this.listText(),
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const name = interaction.options.getString("name", true)
    const result = this.deps.triggerAutomation(name)
    await interaction.reply({
      content: {
        queued: `Queued **${name}**. The report lands in its thread.`,
        busy: `**${name}** is already queued or running.`,
        unknown: `Unknown automation **${name}**.`,
      }[result],
      flags: MessageFlags.Ephemeral,
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
