import { mkdir } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import path from "node:path"

import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { McpAuthRequiredError } from "@earendil-works/pi-mcp"
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Latch,
  Option,
  Schedule,
  Scope,
} from "effect"

import { ThreadRunner } from "./agent/runner.ts"
import { resolveModel } from "./agent/session.ts"
import { modelRuntimeOptions } from "./auth.ts"
import { loadConfig, type Config } from "./config.ts"
import { Gateways, type Gateway, type Intake } from "./gateway.ts"
import { loadDiscordConfig } from "./gateways/discord/config.ts"
import { createDiscordGateway } from "./gateways/discord/gateway.ts"
import { loadSeerrConfig } from "./gateways/seerr/config.ts"
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

/** What a gateway may take from the host when it is built. */
interface GatewayHost {
  runtime: ModelRuntime
  language: string
}

type BuildGateway = (host: GatewayHost) => Gateway

/**
 * Every gateway the host can run, under the name `BLITZCRANK_GATEWAYS` uses.
 * An entry reads the gateway's settings at once, so a missing one stops the
 * service before anything starts, and builds the gateway once the model
 * runtime exists. A new gateway is one more entry here.
 */
const GATEWAYS = new Map<string, () => BuildGateway>([
  [
    "seerr",
    () => {
      const settings = loadSeerrConfig()
      return () => createSeerrGateway(settings)
    },
  ],
  [
    "discord",
    () => {
      const settings = loadDiscordConfig()
      return (host) => createDiscordGateway(settings, host)
    },
  ],
])

function loadGateways(names: readonly string[]): BuildGateway[] {
  return names.map((name) => {
    const load = GATEWAYS.get(name)
    if (!load) {
      throw new Error(
        `BLITZCRANK_GATEWAYS names unknown gateway "${name}"; known: ${[...GATEWAYS.keys()].join(", ")}`,
      )
    }
    return load()
  })
}

export function startServerEffect(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const config = loadConfig()
    const builds = loadGateways(config.gateways)
    const runtime = yield* Effect.tryPromise(() =>
      ModelRuntime.create(modelRuntimeOptions(config)),
    )
    resolveModel(runtime, config.model)
    const host: GatewayHost = { runtime, language: config.language }
    const gateways = new Gateways(
      config.dataDir,
      builds.map((build) => build(host)),
    )
    yield* checkMcpEffect(config)
    yield* storageIO(() => mkdir(config.dataDir, { recursive: true }))
    const jobs = new JobStore(path.join(config.dataDir, "jobs.sqlite"))
    const work = new ThreadWork(
      new ThreadRunner(config, runtime, config.model, jobs, gateways),
      gateways,
      jobs,
      config.maxParallelRuns,
    )

    // Gateways that listen connect before recovery, so a platform that cannot
    // be reached stops the service before a recovered run starts. What they
    // hear waits on this until recovered work is queued and shutdown is in
    // place to stop admission.
    const admission = Latch.makeUnsafe(false)
    const intake: Intake = {
      opened: admission.await,
      submit: (message) => work.enqueueEffect(message),
    }
    // Shutdown closes this scope to stop the gateways that listen before the
    // queue closes. A failed startup closes it too, rather than leaving its
    // connections to the process exit.
    const listening = yield* Scope.make()
    yield* Effect.gen(function* () {
      yield* gateways.listenEffect(intake).pipe(Scope.provide(listening))
      yield* work.restoreEffect()
      const server = createServer(
        createApp({
          gateways,
          intake,
          stats: () => ({ queued: work.queue.size }),
        }),
      )
      server.listen(config.port)
      installShutdown(server, listening, work, jobs)
      yield* admission.open
    }).pipe(
      // Admission never opened, so every message still waiting on it is
      // interrupted before it could act.
      Effect.onError((cause) => Scope.close(listening, Exit.failCause(cause))),
    )
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
  listening: Scope.Closeable,
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
      const deadline = (yield* Clock.currentTimeMillis) + SHUTDOWN_GRACE_MS
      // Listening stops while the queue still takes work: a gateway that is
      // halfway through admitting a message, such as one that has opened its
      // Discord thread, gets to queue its run.
      yield* withDeadline(
        Scope.close(listening, Exit.void),
        deadline,
        "[shutdown] gateways did not stop listening in time",
      )
      work.queue.close()
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
