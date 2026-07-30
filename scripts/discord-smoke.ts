/**
 * Operator smoke test for the Discord integration: verifies config, gateway
 * login, slash-command registration, watch-channel permissions and the
 * report/thread pipeline end to end, without ever running the agent or
 * touching Seerr/Sonarr/Radarr/SABnzbd/Jellyfin.
 *
 * Invocation: `npx tsx scripts/discord-smoke.ts [--cleanup]`
 *
 * SIDE EFFECTS ON THE LIVE SERVER (by design, read the flags before running):
 *   - Calls the real `DiscordBot.start`, which bulk-overwrites the guild's
 *     slash commands and purges any global ones. This is the exact resync
 *     that happens on every real boot; running this script re-syncs commands.
 *   - Creates (or adopts) a private thread named "automation: smoke-test" in
 *     the configured watch channel and posts one synthetic report to it,
 *     through the real `formatAutomationReport`. The thread is left in place
 *     for a human to inspect unless `--cleanup` is passed, in which case it
 *     is deleted at the end of a successful run.
 *   - `triggerAutomation` is stubbed to loudly refuse every call, so even if
 *     an admin fires `/automation run` while this script is connected, no
 *     automation run is queued.
 *
 * Everything else (channel/permission inspection, command listing, thread
 * lookup, message verification) is read-only.
 */
import process from "node:process"

import {
  ChannelType,
  Client,
  Events,
  type AnyThreadChannel,
  type Guild,
  type GuildMember,
  type Message,
  type PermissionsString,
  type TextChannel,
} from "discord.js"

import type {
  AutomationInfo,
  TriggerResult,
} from "../src/automations/dispatcher.js"
import type { AutomationReport } from "../src/automations/runner.js"
import { loadConfig, type Config, type DiscordConfig } from "../src/config.js"
import { DiscordBot, type DiscordDeps } from "../src/discord/bot.js"
import { formatAutomationReport } from "../src/discord/report.js"

const SMOKE_NAME = "smoke-test"
const SMOKE_THREAD_NAME = `automation: ${SMOKE_NAME}`

/** Permissions the bot needs in the watch channel; order is the print order. */
const REQUIRED_PERMISSIONS: PermissionsString[] = [
  "ViewChannel",
  "SendMessages",
  "SendMessagesInThreads",
  "CreatePrivateThreads",
  "ManageThreads",
  "ReadMessageHistory",
]

interface StepResult {
  name: string
  ok: boolean
  detail: string
}

const results: StepResult[] = []

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  const mark = ok ? "\u2713" : "\u2717"
  console.log(`${mark} ${name}: ${detail}`)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fakeReport(): AutomationReport {
  return {
    name: SMOKE_NAME,
    status: "ok",
    body:
      "SYNTHETIC REPORT from scripts/discord-smoke.ts — not a real " +
      "automation run. Safe to ignore or delete this thread.",
    empty: false,
    malformed: false,
    mutations: 0,
    deletes: 0,
    tokens: 0,
  }
}

/**
 * Checks discord config, then does everything else: no agent, no other
 * service, one small side-effect list documented in the header above.
 */
async function main(): Promise<void> {
  const cleanup = process.argv.includes("--cleanup")

  const config = loadConfigOrFail()
  if (!config) return

  const discord = config.discord
  if (!discord) {
    const missing = [
      "DISCORD_BOT_TOKEN",
      "DISCORD_GUILD_ID",
      "DISCORD_WATCH_CHANNEL_ID",
    ].filter((name) => !process.env[name])
    record(
      "config",
      false,
      `discord integration not configured; missing env var(s): ${missing.join(", ")}`,
    )
    return
  }
  record("config", true, "discord config present")

  let bot: DiscordBot | undefined
  let probe: Client<true> | undefined
  try {
    bot = await startBot(config)
    if (!bot) return

    probe = await loginProbe(discord)
    if (!probe) return

    await checkCommands(probe, discord.guildId)

    const channel = await checkChannel(probe, discord)
    if (!channel) return

    const botMember = await checkPermissions(probe, channel)
    if (!botMember) return

    await checkThread(bot, probe, channel, cleanup)
  } finally {
    await bot?.stop().catch((err: unknown) => {
      console.error("[smoke] failed to destroy bot client:", message(err))
    })
    await probe?.destroy().catch((err: unknown) => {
      console.error("[smoke] failed to destroy probe client:", message(err))
    })
  }
}

function loadConfigOrFail(): Config | undefined {
  try {
    return loadConfig()
  } catch (err) {
    record("config", false, `loadConfig() threw: ${message(err)}`)
    return undefined
  }
}

/**
 * The real startup path: gateway login plus the guild command resync.
 * `triggerAutomation` refuses loudly so an interaction firing mid-smoke-test
 * can never queue a real run.
 */
async function startBot(config: Config): Promise<DiscordBot | undefined> {
  const deps: DiscordDeps = {
    listAutomations: (): AutomationInfo[] => [],
    triggerAutomation: (name: string): TriggerResult => {
      console.error(
        `[smoke] REFUSED to trigger automation "${name}": the smoke test ` +
          "must never start a real run",
      )
      return "unknown"
    },
  }
  return DiscordBot.start(config, deps)
    .then((started) => {
      record("gateway login", true, "connected and slash commands synced")
      return started
    })
    .catch((err: unknown) => {
      record("gateway login", false, `DiscordBot.start threw: ${message(err)}`)
      return undefined
    })
}

async function loginProbe(
  discord: DiscordConfig,
): Promise<Client<true> | undefined> {
  const client = new Client({ intents: [], allowedMentions: { parse: [] } })
  client.on(Events.Error, (err) => console.error("[smoke] probe client:", err))
  try {
    const ready = new Promise<Client<true>>((resolve) =>
      client.once(Events.ClientReady, resolve),
    )
    await client.login(discord.token)
    const logged = await ready
    record("probe login", true, `connected as ${logged.user.tag}`)
    return logged
  } catch (err) {
    record(
      "probe login",
      false,
      `read-only client failed to log in: ${message(err)}`,
    )
    await client.destroy().catch(() => undefined)
    return undefined
  }
}

async function checkCommands(
  probe: Client<true>,
  guildId: string,
): Promise<void> {
  const globals = await probe.application.commands.fetch()
  const guildCommands = await probe.application.commands.fetch({ guildId })
  const names = [...guildCommands.values()].map((c) => `/${c.name}`)
  record(
    "guild commands",
    guildCommands.size > 0,
    guildCommands.size > 0
      ? `registered: ${names.join(", ")}`
      : "no commands registered in the guild",
  )
  record(
    "no global commands",
    globals.size === 0,
    globals.size === 0
      ? "confirmed zero global commands"
      : `${globals.size} global command(s) still present: ` +
          [...globals.values()].map((c) => `/${c.name}`).join(", "),
  )
}

async function checkChannel(
  probe: Client<true>,
  discord: DiscordConfig,
): Promise<TextChannel | undefined> {
  let guild: Guild
  try {
    guild = await probe.guilds.fetch(discord.guildId)
  } catch (err) {
    record(
      "watch channel",
      false,
      `cannot fetch guild ${discord.guildId}: ${message(err)}`,
    )
    return undefined
  }

  const channel = await guild.channels
    .fetch(discord.watchChannelId)
    .catch(() => null)
  if (!channel) {
    record(
      "watch channel",
      false,
      `cannot resolve channel ${discord.watchChannelId} in guild ${discord.guildId}`,
    )
    return undefined
  }
  if (channel.type !== ChannelType.GuildText) {
    record(
      "watch channel",
      false,
      `#${channel.name} (${channel.id}) is not a text channel (type=${ChannelType[channel.type]})`,
    )
    return undefined
  }
  record(
    "watch channel",
    true,
    `#${channel.name} (${channel.id}), type=GuildText`,
  )
  return channel
}

async function checkPermissions(
  probe: Client<true>,
  channel: TextChannel,
): Promise<GuildMember | undefined> {
  const botMember = await channel.guild.members
    .fetchMe()
    .catch((err: unknown) => {
      record(
        "bot member",
        false,
        `cannot fetch bot's own membership: ${message(err)}`,
      )
      return undefined
    })
  if (!botMember) return undefined

  const permissions = channel.permissionsFor(botMember)
  const missing = permissions.missing(REQUIRED_PERMISSIONS)
  for (const name of REQUIRED_PERMISSIONS) {
    const has = !missing.includes(name)
    record(
      `permission ${name}`,
      has,
      has ? "granted" : `MISSING in #${channel.name}`,
    )
  }
  return missing.length === 0 ? botMember : undefined
}

async function checkThread(
  bot: DiscordBot,
  probe: Client<true>,
  channel: TextChannel,
  cleanup: boolean,
): Promise<void> {
  const report = fakeReport()
  await bot.report(report)

  const thread = await findThread(channel)
  if (!thread) {
    record(
      "report thread",
      false,
      `"${SMOKE_THREAD_NAME}" was not found after report(); see [discord] logs above`,
    )
    return
  }
  const jumpLink = `https://discord.com/channels/${channel.guild.id}/${thread.id}`
  record("report thread", true, `"${thread.name}" (${thread.id}) — ${jumpLink}`)

  const posted = await lastMessage(thread)
  const expected = formatAutomationReport(report)
  const matches = posted?.content === expected
  record(
    "report message",
    matches,
    matches
      ? "latest thread message matches formatAutomationReport() output"
      : `latest message did not match the expected synthetic report ` +
          `(got: ${JSON.stringify(posted?.content ?? "<none>")})`,
  )

  if (!cleanup) return
  await cleanupThread(thread)
}

/** Never touches a thread whose name is not exactly the smoke-test name. */
async function findThread(
  channel: TextChannel,
): Promise<AnyThreadChannel | undefined> {
  const active = await channel.threads.fetch()
  const archived = await channel.threads
    .fetchArchived({ type: "private" })
    .catch(() => undefined)
  return [
    ...active.threads.values(),
    ...(archived?.threads.values() ?? []),
  ].find((thread) => thread.name === SMOKE_THREAD_NAME)
}

async function lastMessage(
  thread: AnyThreadChannel,
): Promise<Message | undefined> {
  const messages = await thread.messages
    .fetch({ limit: 1 })
    .catch(() => undefined)
  return messages?.first()
}

async function cleanupThread(thread: AnyThreadChannel): Promise<void> {
  if (thread.name !== SMOKE_THREAD_NAME) {
    record(
      "cleanup",
      false,
      `refused to delete "${thread.name}" — name does not exactly match "${SMOKE_THREAD_NAME}"`,
    )
    return
  }
  await thread
    .delete("blitzcrank discord-smoke.ts --cleanup")
    .then(() =>
      record("cleanup", true, `deleted "${thread.name}" (${thread.id})`),
    )
    .catch((err: unknown) =>
      record("cleanup", false, `failed to delete thread: ${message(err)}`),
    )
}

main()
  .catch((err: unknown) => {
    record("smoke test", false, `unhandled error: ${message(err)}`)
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok)
    if (failed.length === 0) {
      console.log(`\nAll ${results.length} checks passed.`)
      process.exit(0)
    }
    console.log(`\n${failed.length}/${results.length} check(s) failed:`)
    for (const step of failed)
      console.log(`  \u2717 ${step.name}: ${step.detail}`)
    process.exit(1)
  })
