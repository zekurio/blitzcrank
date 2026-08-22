import { createServer, type Server } from "node:http"
import path from "node:path"

import {
  ModelRuntime,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent"

import {
  eventMediaScope,
  IssueRunner,
  type IssueEvent,
} from "./agent/runner.ts"
import { DEFAULT_MODEL, resolveModel } from "./agent/session.ts"
import {
  loadAutomations,
  type AutomationDefinition,
} from "./automations/definitions.ts"
import { AutomationDispatcher } from "./automations/dispatcher.ts"
import {
  assertKnownAutomationModels,
  modelSpecForAutomation,
} from "./automations/models.ts"
import { AutomationRunner } from "./automations/runner.ts"
import { AutomationScheduler } from "./automations/scheduler.ts"
import { CaseStore } from "./casefile.ts"
import { loadConfig, type Config } from "./config.ts"
import { DiscordBot } from "./discord/bot.ts"
import { createCommentGate } from "./gateways/seerr/comment-gate.ts"
import { SerialQueue } from "./queue.ts"
import { RevisitScheduler, revisitDelay } from "./revisits.ts"
import { createApp } from "./server.ts"
import { SeerrClient } from "./services/seerr.ts"

/**
 * Total shutdown budget. An active mutation gets time to finish and report,
 * but a stuck run cannot keep the service in `deactivating` indefinitely.
 */
const SHUTDOWN_GRACE_MS = 30_000

interface Models {
  runtime: ModelRuntime
  issueSpec: string
  automationSpec: string
}

interface AutomationWork {
  dispatcher: AutomationDispatcher
  scheduler: AutomationScheduler
  discord: DiscordBot | undefined
}

class IssueWork {
  readonly queue = new SerialQueue()
  readonly revisits = new RevisitScheduler()

  constructor(private readonly runner: IssueRunner) {}

  armRevisit(
    issueId: string,
    delayMs: number,
    reason: string,
    mediaScope: ReturnType<typeof eventMediaScope>,
  ): void {
    this.revisits.schedule(issueId, delayMs, () =>
      this.enqueue({ kind: "revisit", issueId, reason, mediaScope }),
    )
  }

  enqueue(event: IssueEvent): void {
    const runsAhead = this.queue.size
    // Only user-driven runs get a public queue notice. Create its promise
    // before enqueueing so it cannot wait behind the run that will adopt it.
    const queuedStatus =
      event.kind === "webhook" && runsAhead > 0
        ? this.runner.notifyQueued(event.issueId, runsAhead).catch((err) => {
            console.error(
              `[issue:${event.issueId}] queue notification failed; continuing:`,
              err,
            )
            return { id: undefined }
          })
        : Promise.resolve({ id: undefined })
    this.queue.enqueue(async () => {
      const result = await this.runner.run(event, await queuedStatus)
      const revisit = result.casefile.revisit
      if (!revisit) return
      // The case file owns the plan. The timer only mirrors the saved state.
      this.armRevisit(
        result.issueId,
        revisit.delayMs,
        revisit.reason,
        revisit.mediaScope,
      )
    })
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const automations = await loadAutomations(config.automationsDir)
  const models = await loadModels(config, automations)
  const issueWork = new IssueWork(
    new IssueRunner(config, models.runtime, models.issueSpec),
  )
  const automationWork = await startAutomations(
    config,
    automations,
    models,
    issueWork.queue,
  )
  const cases = new CaseStore(path.join(config.dataDir, "cases"))
  await restoreRevisits(cases, issueWork)

  const app = createGatewayApp(config, cases, issueWork, automationWork)
  const server = createServer(app)
  server.listen(config.port, () => {
    if (!config.discord) return
    console.error(
      automationWork.discord
        ? `  discord: channel ${config.discord.watchChannelId}`
        : "  discord: DEGRADED (startup failed; reports disabled)",
    )
  })
  installShutdown(server, issueWork, automationWork)
}

async function loadModels(
  config: Config,
  automations: AutomationDefinition[],
): Promise<Models> {
  const issueSpec = config.model ?? DEFAULT_MODEL
  const automationSpec = config.automationModel ?? issueSpec
  const runtimeOptions: CreateModelRuntimeOptions = {}
  if (config.authPath) runtimeOptions.authPath = config.authPath
  if (config.modelsPath) runtimeOptions.modelsPath = config.modelsPath
  const runtime = await ModelRuntime.create(runtimeOptions)
  assertKnownAutomationModels(automations, config.automationModels)
  const configuredSpecs = new Set([
    issueSpec,
    automationSpec,
    ...automations.map((automation) =>
      modelSpecForAutomation(
        automation.name,
        automationSpec,
        config.automationModels,
      ),
    ),
  ])
  for (const spec of configuredSpecs) resolveModel(runtime, spec)
  return { runtime, issueSpec, automationSpec }
}

async function startAutomations(
  config: Config,
  definitions: AutomationDefinition[],
  models: Models,
  queue: SerialQueue,
): Promise<AutomationWork> {
  const runner = new AutomationRunner(
    config,
    models.runtime,
    models.automationSpec,
    config.automationModels,
  )
  let discord: DiscordBot | undefined
  const dispatcher = new AutomationDispatcher({
    definitions,
    queue,
    run: (definition) => runner.run(definition),
    publish: async (report) => {
      await discord?.report(report)
    },
    nextRun: (name) => scheduler.nextRun(name),
  })
  const scheduler = new AutomationScheduler((definition) =>
    dispatcher.dispatch(definition),
  )
  scheduler.start(definitions)
  discord = await startDiscord(config, dispatcher)
  return { dispatcher, scheduler, discord }
}

async function startDiscord(
  config: Config,
  dispatcher: AutomationDispatcher,
): Promise<DiscordBot | undefined> {
  if (!config.discord) return undefined
  // Discord is a report sink. A startup failure must not stop issue handling
  // or HTTP automation triggers. Invalid config still fails in loadConfig.
  return DiscordBot.start(config, {
    listAutomations: () => dispatcher.list(),
    triggerAutomation: (name) => dispatcher.trigger(name),
  }).catch((cause: unknown) => {
    console.error(
      `[discord] startup failed (guild=${config.discord?.guildId}` +
        ` channel=${config.discord?.watchChannelId}); continuing WITHOUT` +
        ` Discord: no automation reports, HTTP triggers still work:`,
      cause,
    )
    return undefined
  })
}

async function restoreRevisits(
  cases: CaseStore,
  issueWork: IssueWork,
): Promise<void> {
  // Re-arm saved follow-ups. Spread overdue runs through revisitDelay.
  for (const file of await cases.pendingRevisits()) {
    const delayMs = revisitDelay(file, Date.now())
    const revisit = file.revisit
    if (delayMs === undefined || !revisit) continue
    issueWork.armRevisit(
      file.issueId,
      delayMs,
      revisit.reason,
      revisit.mediaScope,
    )
  }
}

function createGatewayApp(
  config: Config,
  cases: CaseStore,
  issueWork: IssueWork,
  automationWork: AutomationWork,
) {
  return createApp({
    config,
    allowComment: createCommentGate(
      new SeerrClient(config.seerr, config.seerrBotUserId),
    ),
    onIssueEvent: (issueId, payload) => {
      // New user activity replaces any pending follow-up for this issue.
      issueWork.revisits.cancel(issueId)
      issueWork.enqueue({ kind: "webhook", issueId, payload })
    },
    onIssueClosed: (issueId) => closeIssue(cases, issueWork, issueId),
    listAutomations: () => automationWork.dispatcher.list(),
    triggerAutomation: (name) => automationWork.dispatcher.trigger(name),
    stats: () => ({
      queued: issueWork.queue.size,
      pendingRevisits: issueWork.revisits.pending,
    }),
  })
}

async function closeIssue(
  cases: CaseStore,
  issueWork: IssueWork,
  issueId: string,
): Promise<void> {
  issueWork.revisits.cancel(issueId)
  const file = await cases.load(issueId)
  if (!file.revisit) return
  file.revisit = undefined
  await cases.save(file)
  console.log(`[revisit] issue=${issueId} resolved; follow-up dropped`)
}

function installShutdown(
  server: Server,
  issueWork: IssueWork,
  automationWork: AutomationWork,
): void {
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      console.warn(`[shutdown] ${signal} ignored; already shutting down`)
      return
    }
    shuttingDown = true
    console.log(`[shutdown] ${signal} received; stopping`)
    automationWork.scheduler.stop()
    console.log("[shutdown] cron scheduler stopped")
    // Revisit plans remain in case files and return on the next start.
    if (issueWork.revisits.pending > 0) {
      console.warn(
        `[shutdown] ${issueWork.revisits.pending} revisit timer(s) dropped;` +
          " re-armed from the case files on next boot",
      )
    }
    const deadline = Date.now() + SHUTDOWN_GRACE_MS
    await closeServer(server, deadline)
    await drainQueue(issueWork.queue, deadline)
    // Stop Discord last so a run can still publish during the grace period.
    await automationWork.discord?.stop().catch((cause: unknown) => {
      console.error("[shutdown] discord client:", cause)
    })
    console.log("[shutdown] bye")
    process.exit(0)
  }
  // Signal emitters cannot await. This handler owns and contains the promise.
  const onSignal = (signal: NodeJS.Signals): void => {
    shutdown(signal).catch((cause: unknown) => {
      console.error("[shutdown] failed:", cause)
      process.exit(1)
    })
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
}

/** Stops accepting webhooks. A keep-alive client cannot pass the deadline. */
async function closeServer(server: Server, deadline: number): Promise<void> {
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

/** Lets an active run finish, but never waits past the deadline. */
async function drainQueue(queue: SerialQueue, deadline: number): Promise<void> {
  if (queue.size === 0) return
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
