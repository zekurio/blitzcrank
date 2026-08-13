import path from "node:path"

import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { serve, type ServerType } from "@hono/node-server"

import {
  eventMediaScope,
  IssueRunner,
  type IssueEvent,
} from "./agent/runner.js"
import { DEFAULT_MODEL, resolveModel } from "./agent/session.js"
import { loadAutomations } from "./automations/definitions.js"
import { AutomationDispatcher } from "./automations/dispatcher.js"
import {
  assertKnownAutomationModels,
  modelSpecForAutomation,
} from "./automations/models.js"
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
import { createApp } from "./server.js"
import { SeerrClient } from "./services/seerr.js"
import { createCommentGate } from "./webhook/comment-gate.js"

/**
 * Total budget for shutdown: how long it waits for the HTTP server to let go
 * of its connections and for an in-flight agent run to finish, before exiting
 * anyway. A run that is mid-mutation deserves a chance to finish and report; a
 * stuck one must not keep the unit in `deactivating` until systemd SIGKILLs it.
 */
const SHUTDOWN_GRACE_MS = 30_000

async function main(): Promise<void> {
  const config = loadConfig()
  const issueModelSpec = config.model ?? DEFAULT_MODEL
  const automationModelSpec = config.automationModel ?? issueModelSpec
  const modelRuntime = await ModelRuntime.create({
    ...(config.authPath ? { authPath: config.authPath } : {}),
    ...(config.modelsPath ? { modelsPath: config.modelsPath } : {}),
  })
  const automations = await loadAutomations(config.automationsDir)
  assertKnownAutomationModels(automations, config.automationModels)
  const configuredModelSpecs = new Set([
    issueModelSpec,
    automationModelSpec,
    ...automations.map((automation) =>
      modelSpecForAutomation(
        automation.name,
        automationModelSpec,
        config.automationModels,
      ),
    ),
  ])
  for (const modelSpec of configuredModelSpecs) {
    resolveModel(modelRuntime, modelSpec)
  }

  const issueRunner = new IssueRunner(config, modelRuntime, issueModelSpec)
  const automationRunner = new AutomationRunner(
    config,
    modelRuntime,
    automationModelSpec,
    config.automationModels,
  )

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
    const runsAhead = queue.size
    // Only user-driven runs get a public queue acknowledgement. Revisit runs
    // were scheduled by blitzcrank itself and should not create extra chatter.
    // The notification promise is created before enqueueing so it cannot wait
    // behind the run it belongs to; the serial task adopts its comment handle.
    const queuedStatus =
      event.kind === "webhook" && runsAhead > 0
        ? issueRunner.notifyQueued(event.issueId, runsAhead).catch((err) => {
            console.error(
              `[issue:${event.issueId}] queue notification failed; continuing:`,
              err,
            )
            return { id: undefined }
          })
        : Promise.resolve({ id: undefined })
    queue.enqueue(async () => {
      const { issueId, casefile } = await issueRunner.run(
        event,
        await queuedStatus,
      )
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
  let discord: DiscordBot | undefined
  const dispatcher = new AutomationDispatcher({
    definitions: automations,
    queue,
    run: (def) => automationRunner.run(def),
    publish: async (report) => {
      await discord?.report(report)
    },
    nextRun: (name) => scheduler.nextRun(name),
  })

  const scheduler = new AutomationScheduler((def) => dispatcher.dispatch(def))
  scheduler.start(automations)

  const listAutomations = () => dispatcher.list()
  const triggerAutomation = (name: string) => dispatcher.trigger(name)

  if (config.discord) {
    // Availability over visibility: Discord is a report sink, not the reason
    // this process exists. A bad token or an unreachable gateway at boot must
    // not stop Jellyseerr issues from being worked, so a startup failure is
    // logged loudly and the gateway continues without reports (HTTP triggers
    // keep working). A malformed *config* stays fatal, in loadConfig().
    discord = await DiscordBot.start(config, {
      listAutomations,
      triggerAutomation,
    }).catch((err: unknown) => {
      console.error(
        `[discord] startup failed (guild=${config.discord?.guildId}` +
          ` channel=${config.discord?.watchChannelId}); continuing WITHOUT` +
          ` Discord: no automation reports, HTTP triggers still work:`,
        err,
      )
      return undefined
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

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    const services = ["sonarr", "radarr", "sabnzbd", "jellyfin"] as const
    const enabled = services.filter((s) => config[s])
    console.log(`blitzcrank listening on :${info.port}`)
    console.log(`  webhook: POST /webhook/seerr`)
    console.log(`  issue model: ${issueModelSpec}`)
    console.log(`  automation model: ${automationModelSpec}`)
    console.log(
      `  services: seerr${enabled.length ? ", " + enabled.join(", ") : ""}`,
    )
    if (config.discord) {
      console.log(
        discord
          ? `  discord: channel ${config.discord.watchChannelId}`
          : `  discord: DEGRADED (startup failed; reports disabled)`,
      )
    }
    for (const def of automations) {
      const modelSpec = modelSpecForAutomation(
        def.name,
        automationModelSpec,
        config.automationModels,
      )
      console.log(
        `  automation: ${def.name} (${def.schedule}${def.enabled ? "" : ", disabled"})` +
          ` model=${modelSpec} next=${scheduler.nextRun(def.name) ?? "-"}`,
      )
    }
  })

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      console.warn(`[shutdown] ${signal} ignored; already shutting down`)
      return
    }
    shuttingDown = true
    console.log(`[shutdown] ${signal} received; stopping`)

    scheduler.stop()
    console.log("[shutdown] cron scheduler stopped")
    // RevisitScheduler only cancels per issue, and its timers are unref'd with
    // the plan behind them persisted in the case files, so pending follow-ups
    // re-arm from disk on the next boot instead of being lost here.
    if (revisits.pending > 0) {
      console.log(
        `[shutdown] ${revisits.pending} revisit timer(s) dropped;` +
          ` re-armed from the case files on next boot`,
      )
    }

    const deadline = Date.now() + SHUTDOWN_GRACE_MS
    await closeServer(server, deadline)
    await drainQueue(queue, dispatcher, deadline)
    // Stopped last so a run finishing inside the grace period can still get
    // its report out.
    await discord?.stop().catch((err: unknown) => {
      console.error("[shutdown] discord client:", err)
    })

    console.log("[shutdown] bye")
    process.exit(0)
  }

  // The signal emitter cannot await; this handler owns its awaits, contains
  // its failures, and is the one that exits the process.
  const onSignal = (signal: NodeJS.Signals): void => {
    shutdown(signal).catch((err: unknown) => {
      console.error("[shutdown] failed:", err)
      process.exit(1)
    })
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
}

/** Stops accepting webhooks, bounded so a keep-alive client cannot hang us. */
async function closeServer(
  server: ServerType,
  deadline: number,
): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
  await withDeadline(
    closed,
    deadline,
    "[shutdown] http server did not close in time",
  )
  console.log("[shutdown] http server closed")
}

/** Lets an in-flight agent run finish, but never waits past the deadline. */
async function drainQueue(
  queue: SerialQueue,
  dispatcher: AutomationDispatcher,
  deadline: number,
): Promise<void> {
  if (queue.size === 0) return
  const active = dispatcher.active
  console.log(
    `[shutdown] ${queue.size} run(s) in flight` +
      `${active.length > 0 ? ` (automations: ${active.join(", ")})` : ""};` +
      ` finishing, up to ${Math.round((deadline - Date.now()) / 1000)}s`,
  )
  const drained = (async () => {
    while (queue.size > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250).unref?.()
      })
    }
  })()
  await withDeadline(
    drained,
    deadline,
    "[shutdown] grace period expired with runs still in flight; exiting anyway",
  )
}

async function withDeadline(
  task: Promise<void>,
  deadline: number,
  timeoutLog: string,
): Promise<void> {
  const expired = new Promise<void>((resolve) => {
    setTimeout(
      () => {
        console.warn(timeoutLog)
        resolve()
      },
      Math.max(deadline - Date.now(), 0),
    ).unref?.()
  })
  await Promise.race([task, expired])
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
