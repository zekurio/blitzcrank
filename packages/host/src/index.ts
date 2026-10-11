import { mkdir } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import path from "node:path"

import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { McpAuthRequiredError } from "@earendil-works/pi-mcp"
import { Cause, Clock, Effect, Option, Schedule } from "effect"

import { ThreadRunner } from "./agent/runner.ts"
import { resolveModel } from "./agent/session.ts"
import { modelRuntimeOptions } from "./auth.ts"
import { loadConfig, type Config } from "./config.ts"
import { Gateways } from "./gateway.ts"
import { createSeerrGateway } from "./gateways/seerr/gateway.ts"
import { JobStore } from "./jobs.ts"
import { connectMcpEffect } from "./mcp/client.ts"
import { createApp } from "./server.ts"
import { storageIO } from "./storage.ts"
import { ThreadWork } from "./thread-work.ts"

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
    yield* checkMcpEffect(config)
    yield* storageIO(() => mkdir(config.dataDir, { recursive: true }))
    const jobs = new JobStore(path.join(config.dataDir, "jobs.sqlite"))
    // A new gateway is one more entry here.
    const gateways = new Gateways(config.dataDir, [createSeerrGateway(config)])
    const work = new ThreadWork(
      new ThreadRunner(config, runtime, config.model, jobs, gateways),
      gateways,
      jobs,
      config.maxParallelRuns,
    )
    yield* work.restoreEffect()

    const server = createServer(
      createApp({
        gateways,
        intake: { submit: (message) => work.enqueueEffect(message) },
        stats: () => ({ queued: work.queue.size }),
      }),
    )
    server.listen(config.port)
    installShutdown(server, work, jobs)
  })
}

/** Startup waits this long for a server that is still coming up. */
const MCP_STARTUP_RETRIES = 10
const MCP_STARTUP_RETRY_SPACING = "2 seconds"

/**
 * Every run depends on the MCP server. A wrong URL or token should stop the
 * service at boot, not fail each run one by one. The server is a separate
 * unit that may still be binding its port, so an unreachable server is retried
 * briefly. A rejected token is not: waiting cannot fix it.
 */
function checkMcpEffect(config: Config) {
  return connectMcpEffect(config.mcp).pipe(
    Effect.tap((mcp) =>
      Effect.sync(() => {
        console.log(
          `[mcp] ${config.mcp.url} offers ${mcp.tools.length} tools: ${mcp.tools
            .map((tool) => tool.name)
            .join(", ")}`,
        )
      }),
    ),
    Effect.scoped,
    Effect.asVoid,
    Effect.tapError((error) =>
      Effect.sync(() => console.warn(`[mcp] ${error.message}`)),
    ),
    Effect.retry({
      times: MCP_STARTUP_RETRIES,
      schedule: Schedule.spaced(MCP_STARTUP_RETRY_SPACING),
      while: (error) => !(error.cause instanceof McpAuthRequiredError),
    }),
  )
}

function installShutdown(
  server: Server,
  work: ThreadWork,
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
      work.queue.close()
      const deadline = (yield* Clock.currentTimeMillis) + SHUTDOWN_GRACE_MS
      yield* withDeadline(
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void))
        }),
        deadline,
        "[shutdown] http server did not close in time",
      )
      yield* withDeadline(
        work.queue.drainEffect(),
        deadline,
        "[shutdown] grace period expired with runs still in flight; exiting anyway",
      )
      // A deadline does not interrupt writes. Keep their journal open until the
      // process exits; closing it under an active tool would lose its outcome.
      if (work.queue.size === 0) jobs.close()
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
