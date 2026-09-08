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
import { loadConfig, type Config } from "./config.ts"
import { DiscordAgent } from "./discord/agent.ts"
import { DiscordBot } from "./discord/bot.ts"
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
  discordSpec: string
  discordTriageSpec: string
}

interface AutomationWork {
  dispatcher: AutomationDispatcher
  scheduler: AutomationScheduler
  discord: DiscordBot | undefined
}

function main(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const config = loadConfig()
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
      if (!config.discord) return
      console.error(
        automationWork.discord
          ? `  discord: watch ${config.discord.watchChannelId}` +
              (config.discord.inboxChannelId
                ? `, inbox ${config.discord.inboxChannelId}`
                : "")
          : "  discord: DEGRADED (startup failed; reports and conversations disabled)",
      )
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
    const discordSpec = config.discord?.model ?? issueSpec
    const discordTriageSpec = config.discord?.triageModel ?? discordSpec
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
      ...(config.discord?.inboxChannelId
        ? [discordSpec, discordTriageSpec]
        : []),
    ])
    for (const spec of configuredSpecs) resolveModel(runtime, spec)
    return {
      runtime,
      issueSpec,
      automationSpec,
      discordSpec,
      discordTriageSpec,
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
    let discord: DiscordBot | undefined
    const dispatcher = new AutomationDispatcher({
      definitions,
      queue,
      run: (definition) => runner.runEffect(definition),
      publish: (report) => discord?.reportEffect(report) ?? Effect.void,
      nextRun: (name) => scheduler.nextRun(name),
    })
    const scheduler = new AutomationScheduler((definition) =>
      dispatcher.dispatch(definition),
    )
    scheduler.start(definitions)
    discord = yield* startDiscord(config, dispatcher, models, queue)
    return { dispatcher, scheduler, discord }
  })
}

function startDiscord(
  config: Config,
  dispatcher: AutomationDispatcher,
  models: Models,
  queue: SerialQueue,
): Effect.Effect<DiscordBot | undefined, unknown> {
  return Effect.gen(function* () {
    if (!config.discord) return undefined
    const chat = config.discord.inboxChannelId
      ? new DiscordAgent(
          config,
          models.runtime,
          models.discordSpec,
          models.discordTriageSpec,
          queue,
        )
      : undefined
    // Discord is an optional surface. A startup failure must not stop issue
    // handling or HTTP automation triggers. Invalid config fails in loadConfig.
    return yield* DiscordBot.startEffect(config, {
      listAutomations: () => dispatcher.list(),
      triggerAutomation: (name) => dispatcher.trigger(name),
      chat,
    }).pipe(
      Effect.catchCause((cause) => {
        console.error(
          `[discord] startup failed (guild=${config.discord?.guildId}` +
            ` watch=${config.discord?.watchChannelId}` +
            ` inbox=${config.discord?.inboxChannelId ?? "-"}); continuing WITHOUT` +
            ` Discord: no reports or conversations, HTTP triggers still work:`,
          Cause.squash(cause),
        )
        return Effect.succeed(undefined)
      }),
    )
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
      // Discord stays connected until the drain finishes so reports can land.
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
      if (automationWork.discord) {
        yield* withDeadline(
          automationWork.discord
            .stopEffect()
            .pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  console.error(
                    "[shutdown] discord client:",
                    Cause.squash(cause),
                  ),
                ),
              ),
            ),
          deadline,
          "[shutdown] discord client did not close in time",
        )
      }
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
