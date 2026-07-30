import path from "node:path"

import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { serve } from "@hono/node-server"

import {
  eventMediaScope,
  IssueRunner,
  type IssueEvent,
} from "./agent/runner.js"
import { DEFAULT_MODEL } from "./agent/session.js"
import {
  loadAutomations,
  type AutomationDefinition,
} from "./automations/definitions.js"
import { AutomationRunner } from "./automations/runner.js"
import { AutomationScheduler } from "./automations/scheduler.js"
import { CaseStore } from "./casefile.js"
import { loadConfig } from "./config.js"
import { DiscordBot } from "./discord/bot.js"
import { SerialQueue } from "./queue.js"
import {
  MAX_REVISIT_CHAIN,
  RevisitScheduler,
  revisitDelay,
} from "./revisits.js"
import { createApp, type AutomationInfo, type TriggerResult } from "./server.js"
import { SeerrClient } from "./services/seerr.js"
import { createCommentGate } from "./webhook/comment-gate.js"

async function main(): Promise<void> {
  const config = loadConfig()
  const modelSpec = config.model ?? DEFAULT_MODEL
  const modelRuntime = await ModelRuntime.create({
    ...(config.authPath ? { authPath: config.authPath } : {}),
    ...(config.modelsPath ? { modelsPath: config.modelsPath } : {}),
  })

  const issueRunner = new IssueRunner(config, modelRuntime, modelSpec)
  const automationRunner = new AutomationRunner(config, modelRuntime, modelSpec)
  const automations = await loadAutomations(config.automationsDir)

  const queue = new SerialQueue()
  const revisits = new RevisitScheduler()

  const armRevisit = (
    issueId: string,
    delayMs: number,
    reason: string,
    mediaScope: ReturnType<typeof eventMediaScope>,
    chain: number,
  ): void => {
    console.log(
      `[revisit] issue=${issueId} in ${Math.round(delayMs / 60000)}m (${chain}/${MAX_REVISIT_CHAIN}): ${reason}`,
    )
    revisits.schedule(issueId, delayMs, () =>
      enqueueIssue({ kind: "revisit", issueId, reason, mediaScope }),
    )
  }

  const enqueueIssue = (event: IssueEvent): void => {
    queue.enqueue(async () => {
      const { issueId, casefile } = await issueRunner.run(event)
      // The runner persisted the plan; the timer only mirrors it, so a restart
      // re-arms from disk instead of silently dropping the follow-up.
      const revisit = casefile.revisit
      if (revisit) {
        armRevisit(
          issueId,
          revisit.delayMs,
          revisit.reason,
          revisit.mediaScope,
          revisit.chain,
        )
      }
    })
  }

  // One run per automation at a time: a cron tick or a Discord trigger that
  // arrives while the same task is queued or in flight is refused, not stacked.
  const inFlight = new Set<string>()
  let discord: DiscordBot | undefined

  const enqueueAutomation = (def: AutomationDefinition): TriggerResult => {
    if (inFlight.has(def.name)) {
      console.warn(
        `[automation:${def.name}] already queued or running; skipped`,
      )
      return "busy"
    }
    inFlight.add(def.name)
    queue.enqueue(async () => {
      try {
        const report = await automationRunner.run(def)
        await discord?.report(report)
      } finally {
        inFlight.delete(def.name)
      }
    })
    return "queued"
  }

  const scheduler = new AutomationScheduler(enqueueAutomation)
  scheduler.start(automations)

  const listAutomations = (): AutomationInfo[] =>
    automations.map((def) => ({
      name: def.name,
      description: def.description,
      schedule: def.schedule,
      enabled: def.enabled,
      capabilities: def.capabilities,
      nextRun: scheduler.nextRun(def.name),
    }))

  const triggerAutomation = (name: string): TriggerResult => {
    const def = automations.find((d) => d.name === name)
    if (!def) return "unknown"
    return enqueueAutomation(def)
  }

  if (config.discord) {
    discord = await DiscordBot.start(config, {
      listAutomations,
      triggerAutomation,
    })
  }

  const cases = new CaseStore(path.join(config.dataDir, "cases"))
  // Follow-ups survive a restart: pending revisits are re-armed from the case
  // files, overdue ones shortly after boot rather than all at once.
  for (const file of await cases.pendingRevisits()) {
    const delayMs = revisitDelay(file, Date.now())
    const revisit = file.revisit
    if (delayMs === undefined || !revisit) continue
    armRevisit(
      file.issueId,
      delayMs,
      revisit.reason,
      revisit.mediaScope,
      revisit.chain,
    )
  }

  const app = createApp({
    config,
    allowComment: createCommentGate(
      new SeerrClient(config.seerr, config.seerrBotUserId),
    ),
    onIssueEvent: (issueId, payload) => {
      // New user activity supersedes any scheduled follow-up for this issue.
      revisits.cancel(issueId)
      enqueueIssue({ kind: "webhook", issueId, payload })
    },
    onIssueClosed: async (issueId) => {
      revisits.cancel(issueId)
      const file = await cases.load(issueId)
      if (!file.revisit) return
      file.revisit = undefined
      await cases.save(file)
      console.log(`[revisit] issue=${issueId} resolved; follow-up dropped`)
    },
    listAutomations,
    triggerAutomation,
    stats: () => ({ queued: queue.size, pendingRevisits: revisits.pending }),
  })

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    const services = [
      "sonarr",
      "radarr",
      "sabnzbd",
      "jellyfin",
      "anvil",
    ] as const
    const enabled = services.filter((s) => config[s])
    console.log(`blitzcrank listening on :${info.port}`)
    console.log(`  webhook: POST /webhook/seerr`)
    console.log(`  model: ${modelSpec}`)
    console.log(
      `  services: seerr${enabled.length ? ", " + enabled.join(", ") : ""}`,
    )
    if (config.discord) {
      console.log(`  discord: channel ${config.discord.watchChannelId}`)
    }
    for (const def of automations) {
      console.log(
        `  automation: ${def.name} (${def.schedule}${def.enabled ? "" : ", disabled"})` +
          ` next=${scheduler.nextRun(def.name) ?? "-"}`,
      )
    }
  })
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
