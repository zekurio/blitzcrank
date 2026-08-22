import {
  Client,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js"

import type {
  AutomationInfo,
  TriggerResult,
} from "../automations/dispatcher.ts"
import type { AutomationReport } from "../automations/runner.ts"
import type { Config, DiscordConfig } from "../config.ts"
import { AUTOMATION_COMMAND, syncCommands } from "./commands.ts"
import { formatAutomationReport } from "./report.ts"
import { AutomationThreads } from "./threads.ts"

export interface DiscordDeps {
  listAutomations: () => AutomationInfo[]
  /** Enqueues a checked-in automation; the only inbound effect Discord has. */
  triggerAutomation: (name: string) => TriggerResult
}

/**
 * Host-side Discord surface: automation reports out, automation triggers in.
 *
 * The gateway connection declares no intents, so the bot cannot receive
 * messages at all — the only inbound data is a signed interaction naming a
 * checked-in automation. No Discord text ever reaches a model, and no agent
 * tool can write here.
 */
export class DiscordBot {
  private constructor(
    private readonly client: Client<true>,
    private readonly discord: DiscordConfig,
    private readonly threads: AutomationThreads,
    private readonly deps: DiscordDeps,
  ) {}

  static async start(config: Config, deps: DiscordDeps): Promise<DiscordBot> {
    const discord = config.discord
    if (!discord) throw new Error("DiscordBot.start without discord config")

    const client = new Client({
      intents: [],
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
    const bot = new DiscordBot(logged, discord, threads, deps)
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
