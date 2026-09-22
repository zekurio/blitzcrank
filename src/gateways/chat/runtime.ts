import { Cause, Effect, Exit } from "effect"

import type { AutomationReport } from "../../automations/runner.ts"

/** A running outbound/inbound chat gateway. */
export interface GatewayRuntime {
  readonly id: string
  reportEffect(report: AutomationReport): Effect.Effect<void, unknown>
  stopEffect(): Effect.Effect<void, unknown>
}

/**
 * Platform adapters own their channel, thread, and authorization rules. The
 * conversation runner only needs a stable opaque id and delivery callbacks.
 */
export interface ConversationRuntime {
  triageEffect(
    messageId: string,
    content: string,
  ): Effect.Effect<{ respond: boolean; title: string }, unknown>
  enqueue(
    conversationId: string,
    content: string,
    deliver: (response: string) => Effect.Effect<void, unknown>,
    fail: () => Effect.Effect<void, unknown>,
  ): boolean
}

/**
 * Setup is interruptible; no agent work exists yet. A failed or timed-out
 * adapter must close its pending connection before the host discards it.
 */
export function initializeGateway<A, E>(
  id: string,
  setup: Effect.Effect<A, E>,
  cleanup: () => Effect.Effect<void, unknown>,
  timeoutMs = 30_000,
) {
  return setup.pipe(
    Effect.interruptible,
    Effect.timeout(timeoutMs),
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.suspend(cleanup).pipe(
            Effect.timeout(5_000),
            Effect.interruptible,
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                console.error(
                  `[gateway:${id}] startup cleanup failed:`,
                  Cause.squash(cause),
                ),
              ),
            ),
          )
        : Effect.void,
    ),
  )
}

export function connectGateways(
  adapters: ReadonlyArray<{
    id: string
    start: () => Effect.Effect<GatewayRuntime, unknown>
  }>,
): Effect.Effect<GatewayRuntime[]> {
  return Effect.forEach(
    adapters,
    (adapter) =>
      Effect.suspend(adapter.start).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error(
              `[gateway:${adapter.id}] startup failed; continuing without it:`,
              Cause.squash(cause),
            )
            return undefined
          }),
        ),
      ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((gateways) =>
      gateways.filter((gateway) => gateway !== undefined),
    ),
  )
}

export function publishToGateways(
  gateways: readonly GatewayRuntime[],
  report: AutomationReport,
): Effect.Effect<void> {
  return Effect.forEach(
    gateways,
    (gateway) =>
      Effect.suspend(() => gateway.reportEffect(report)).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            console.error(
              `[gateway:${gateway.id}] report failed:`,
              Cause.squash(cause),
            ),
          ),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  )
}

export function stopGateways(
  gateways: readonly GatewayRuntime[],
): Effect.Effect<void> {
  return Effect.forEach(
    gateways,
    (gateway) =>
      Effect.suspend(() => gateway.stopEffect()).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            console.error(
              `[gateway:${gateway.id}] stop failed:`,
              Cause.squash(cause),
            ),
          ),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  )
}
