import { createServer, type Server } from "node:http"
import path from "node:path"

import {
  ModelRuntime,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent"
import { Cause, Clock, Effect, Option } from "effect"

import { IssueRunner } from "./agent/runner.ts"
import { DEFAULT_MODEL, resolveModel } from "./agent/session.ts"
import {
  loadAutomationsEffect,
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
import { loadConfigEffect, type Config, type GatewayConfig } from "./config.ts"
import { DiscordAgent } from "./discord/agent.ts"
import { DiscordBot } from "./discord/bot.ts"
import {
  connectGateways,
  publishToGateways,
  stopGateways,
  type GatewayRuntime,
} from "./gateways/chat/runtime.ts"
import { createCommentGateEffect } from "./gateways/seerr/comment-gate.ts"
import { IssueWork } from "./issue-work.ts"
import { SerialQueue } from "./queue.ts"
import { revisitDelay } from "./revisits.ts"
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
  gateways: ReadonlyMap<string, GatewayModels>
}

interface GatewayModels {
  conversationSpec: string
  triageSpec: string
}

interface AutomationWork {
  dispatcher: AutomationDispatcher
  scheduler: AutomationScheduler
  gateways: GatewayRuntime[]
}

function main(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const config = yield* loadConfigEffect()
    const automations = yield* loadAutomationsEffect(config.automationsDir)
    const models = yield* loadModels(config, automations)
    const cases = new CaseStore(path.join(config.dataDir, "cases"))
    const issueWork = new IssueWork(
      new IssueRunner(config, models.runtime, models.issueSpec),
      cases,
    )
    const automationWork = yield* startAutomations(
      config,
      automations,
      models,
      issueWork.queue,
    )
    yield* restoreRevisits(cases, issueWork)

    const app = createGatewayApp(config, cases, issueWork, automationWork)
    const server = createServer(app)
    server.listen(config.port, () => {
      for (const gateway of config.gateways) {
        const running = automationWork.gateways.some(
          (candidate) => candidate.id === gateway.id,
        )
        console.error(
          running
            ? `  ${gateway.type}:${gateway.id}: reports ${gateway.reportChannelId}` +
                (gateway.inboxChannelIds.length > 0
                  ? `, inboxes ${gateway.inboxChannelIds.join(",")}`
                  : "")
            : `  ${gateway.type}:${gateway.id}: DEGRADED (startup failed)`,
        )
      }
    })
    installShutdown(server, issueWork, automationWork)
  })
}

function loadModels(
  config: Config,
  automations: AutomationDefinition[],
): Effect.Effect<Models, unknown> {
  return Effect.gen(function* () {
    const issueSpec = config.model ?? DEFAULT_MODEL
    const automationSpec = config.automationModel ?? issueSpec
    const gateways = new Map(
      config.gateways.map((gateway) => {
        const conversationSpec = gateway.model ?? issueSpec
        return [
          gateway.id,
          {
            conversationSpec,
            triageSpec: gateway.triageModel ?? conversationSpec,
          },
        ]
      }),
    )
    const runtimeOptions: CreateModelRuntimeOptions = {}
    if (config.authPath) runtimeOptions.authPath = config.authPath
    if (config.modelsPath) runtimeOptions.modelsPath = config.modelsPath
    const runtime = yield* Effect.tryPromise(() =>
      ModelRuntime.create(runtimeOptions),
    )
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
      ...config.gateways.flatMap((gateway) => {
        if (gateway.inboxChannelIds.length === 0) return []
        const specs = gateways.get(gateway.id)
        return specs ? [specs.conversationSpec, specs.triageSpec] : []
      }),
    ])
    for (const spec of configuredSpecs) resolveModel(runtime, spec)
    return {
      runtime,
      issueSpec,
      automationSpec,
      gateways,
    }
  })
}

function startAutomations(
  config: Config,
  definitions: AutomationDefinition[],
  models: Models,
  queue: SerialQueue,
): Effect.Effect<AutomationWork, unknown> {
  return Effect.gen(function* () {
    const runner = new AutomationRunner(
      config,
      models.runtime,
      models.automationSpec,
      config.automationModels,
    )
    let gateways: GatewayRuntime[] = []
    const dispatcher = new AutomationDispatcher({
      definitions,
      queue,
      run: (definition) => runner.runEffect(definition),
      publish: (report) => publishToGateways(gateways, report),
      nextRun: (name) => scheduler.nextRun(name),
    })
    const scheduler = new AutomationScheduler((definition) =>
      dispatcher.dispatch(definition),
    )
    scheduler.start(definitions)
    gateways = yield* startGateways(config, dispatcher, models, queue)
    return { dispatcher, scheduler, gateways }
  })
}

function startGateways(
  config: Config,
  dispatcher: AutomationDispatcher,
  models: Models,
  queue: SerialQueue,
): Effect.Effect<GatewayRuntime[]> {
  return connectGateways(
    config.gateways.map((gateway) => ({
      id: gateway.id,
      start: () => startGateway(config, gateway, dispatcher, models, queue),
    })),
  )
}

function startGateway(
  config: Config,
  gateway: GatewayConfig,
  dispatcher: AutomationDispatcher,
  models: Models,
  queue: SerialQueue,
): Effect.Effect<GatewayRuntime, unknown> {
  return Effect.gen(function* () {
    const gatewayModels = models.gateways.get(gateway.id)
    if (!gatewayModels)
      return yield* Effect.die(`missing models for ${gateway.id}`)
    const chat =
      gateway.inboxChannelIds.length > 0
        ? new DiscordAgent(
            config,
            gateway.id,
            models.runtime,
            gatewayModels.conversationSpec,
            gatewayModels.triageSpec,
            queue,
          )
        : undefined
    return yield* DiscordBot.startEffect(gateway, config.language, {
      listAutomations: () => dispatcher.list(),
      triggerAutomation: (name) => dispatcher.trigger(name),
      chat,
    })
  })
}

function restoreRevisits(
  cases: CaseStore,
  issueWork: IssueWork,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    // Re-arm saved follow-ups. Spread overdue runs through revisitDelay.
    for (const file of yield* cases.pendingRevisitsEffect()) {
      if (yield* cases.isPausedEffect(file.issueId)) continue
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
  })
}

function createGatewayApp(
  config: Config,
  cases: CaseStore,
  issueWork: IssueWork,
  automationWork: AutomationWork,
) {
  return createApp({
    config,
    allowComment: createCommentGateEffect(
      new SeerrClient(config.seerr, config.seerrBotUserId),
    ),
    onIssueEvent: (issueId, payload) =>
      Effect.suspend(() => {
        // New user activity replaces any pending follow-up for this issue.
        issueWork.revisits.cancel(issueId)
        return issueWork.enqueueEffect({ kind: "webhook", issueId, payload })
      }),
    onIssueStop: (issueId) => issueWork.stopEffect(issueId),
    onIssueResume: (issueId) => issueWork.resumeEffect(issueId),
    onIssueClosed: (issueId) => closeIssue(cases, issueWork, issueId),
    listAutomations: () => automationWork.dispatcher.list(),
    triggerAutomation: (name) => automationWork.dispatcher.trigger(name),
    stats: () => ({
      queued: issueWork.queue.size,
      pendingRevisits: issueWork.revisits.pending,
    }),
  })
}

function closeIssue(
  cases: CaseStore,
  issueWork: IssueWork,
  issueId: string,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    issueWork.revisits.cancel(issueId)
    const file = yield* cases.loadEffect(issueId)
    if (!file.revisit) return
    file.revisit = undefined
    yield* cases.saveEffect(file)
    console.log(`[revisit] issue=${issueId} resolved; follow-up dropped`)
  })
}

function installShutdown(
  server: Server,
  issueWork: IssueWork,
  automationWork: AutomationWork,
): void {
  let shuttingDown = false
  const shutdown = (signal: string) =>
    Effect.gen(function* () {
      if (shuttingDown) {
        console.warn(`[shutdown] ${signal} ignored; already shutting down`)
        return
      }
      shuttingDown = true
      console.log(`[shutdown] ${signal} received; stopping`)
      automationWork.scheduler.stop()
      issueWork.revisits.stop()
      // Persisted revisit plans return at boot. Stop all new queue admission now;
      // Gateways stay connected until the drain finishes so reports can land.
      issueWork.queue.close()
      const deadline = (yield* Clock.currentTimeMillis) + SHUTDOWN_GRACE_MS
      yield* withDeadline(
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void))
        }),
        deadline,
        "[shutdown] http server did not close in time",
      )
      yield* withDeadline(
        issueWork.queue.drainEffect(),
        deadline,
        "[shutdown] grace period expired with runs still in flight; exiting anyway",
      )
      yield* withDeadline(
        stopGateways(automationWork.gateways),
        deadline,
        "[shutdown] gateway clients did not close in time",
      )
      console.log("[shutdown] bye")
      process.exit(0)
    })
  // Signal emitters cannot await. This boundary owns and contains the fiber.
  const onSignal = (signal: NodeJS.Signals): void => {
    Effect.runFork(
      shutdown(signal).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error("[shutdown] failed:", Cause.squash(cause))
            process.exit(1)
          }),
        ),
      ),
    )
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
}

function withDeadline(
  task: Effect.Effect<void, unknown>,
  deadline: number,
  timeoutLog: string,
) {
  return Effect.gen(function* () {
    const remaining = Math.max(deadline - (yield* Clock.currentTimeMillis), 0)
    const result = yield* task.pipe(Effect.timeoutOption(remaining))
    if (Option.isNone(result)) console.warn(timeoutLog)
  })
}

Effect.runFork(
  main().pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.error("fatal:", Cause.squash(cause))
        process.exit(1)
      }),
    ),
  ),
)
