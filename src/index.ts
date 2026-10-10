import { mkdir } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import path from "node:path"

import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Cause, Clock, Effect, Option } from "effect"

import { IssueRunner } from "./agent/runner.ts"
import { resolveModel } from "./agent/session.ts"
import { modelRuntimeOptions } from "./auth.ts"
import { CaseStore } from "./casefile.ts"
import { loadConfig, type Config } from "./config.ts"
import { createCommentGateEffect } from "./gateways/seerr/comment-gate.ts"
import { IssueWork } from "./issue-work.ts"
import { JobStore } from "./jobs.ts"
import { revisitDelay } from "./revisits.ts"
import { createApp } from "./server.ts"
import { SeerrClient } from "./services/seerr.ts"
import { storageIO } from "./storage.ts"

/**
 * Total shutdown budget. An active mutation gets time to finish and report,
 * but a stuck run cannot keep the service in `deactivating` indefinitely.
 */
const SHUTDOWN_GRACE_MS = 30_000

export function startServerEffect(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const config = loadConfig()
    const runtime = yield* Effect.tryPromise(() =>
      ModelRuntime.create(modelRuntimeOptions(config)),
    )
    resolveModel(runtime, config.model)
    yield* storageIO(() => mkdir(config.dataDir, { recursive: true }))
    const jobs = new JobStore(path.join(config.dataDir, "jobs.sqlite"))
    const cases = new CaseStore(path.join(config.dataDir, "cases"))
    const allowComment = createCommentGateEffect(
      new SeerrClient(config.seerr, config.seerrBotUserId),
    )
    const issueWork = new IssueWork(
      new IssueRunner(config, runtime, config.model, jobs),
      cases,
      jobs,
      (event) =>
        event.kind === "webhook" &&
        event.payload.notification_type === "ISSUE_COMMENT"
          ? allowComment(event.payload)
          : Effect.succeed(true),
    )
    yield* issueWork.restoreEffect()
    yield* restoreRevisits(cases, issueWork)

    const server = createServer(createGatewayApp(config, cases, issueWork))
    server.listen(config.port)
    installShutdown(server, issueWork, jobs)
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
      if (issueWork.hasPending(file.issueId)) continue
      const delayMs = revisitDelay(file, Date.now())
      const revisit = file.revisit
      if (delayMs === undefined || !revisit) continue
      issueWork.armRevisit(
        file.issueId,
        delayMs,
        revisit.reason,
        revisit.mediaScope,
        revisit.dueAt,
      )
    }
  })
}

function createGatewayApp(
  config: Config,
  cases: CaseStore,
  issueWork: IssueWork,
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
  jobs: JobStore,
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
      issueWork.revisits.stop()
      // Persisted revisit plans return at boot. Stop all new queue admission now.
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
      // A deadline does not interrupt writes. Keep their journal open until the
      // process exits; closing it under an active tool would lose its outcome.
      if (issueWork.queue.size === 0) jobs.close()
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
