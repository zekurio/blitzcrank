import path from "node:path"

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
} from "../automations/dispatcher.js"
import type { AutomationReport } from "../automations/runner.js"
import type { Config, DiscordConfig } from "../config.js"
import { AUTOMATION_COMMAND, syncCommands } from "./commands.js"
import { formatAutomationReport } from "./report.js"
import { AutomationThreads } from "./threads.js"

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
      path.join(config.dataDir, "discord", "threads.json"),
    )
    const bot = new DiscordBot(logged, discord, threads, deps)
    await syncCommands(
      logged,
      discord.guildId,
      deps.listAutomations().map((info) => info.name),
    )
    logged.on(Events.InteractionCreate, async (interaction) => {
      // The listener only enqueues; run lifecycles stay with the serial queue.
      // Nothing awaits it, so it must contain its own failures.
      if (!interaction.isChatInputCommand()) return
      await bot.onCommand(interaction).catch((err) => {
        console.error("[discord] interaction failed:", err)
      })
    })
    console.log(
      `[discord] connected as ${logged.user.tag}, watching #${await threads.verify()}`,
    )
    return bot
  }

  /** A broken report sink must never fail the run it reports on. */
  async report(report: AutomationReport): Promise<void> {
    const thread = await this.threads.get(report.name).catch((err: unknown) => {
      console.error(`[discord] thread for ${report.name}:`, err)
      return undefined
    })
    if (!thread) return
    await thread.send(formatAutomationReport(report)).catch((err: unknown) => {
      console.error(`[discord] report for ${report.name}:`, err)
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
    console.log(
      `[discord] /${AUTOMATION_COMMAND} run ${name} by ${interaction.user.tag}: ${result}`,
    )
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
          (info.capabilities.length > 0
            ? `\n  caps: ${info.capabilities.join(", ")}`
            : "\n  caps: none (read-only)"),
      )
      .join("\n")
      .slice(0, 1900)
  }
}
