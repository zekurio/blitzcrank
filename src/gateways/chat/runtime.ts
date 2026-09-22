import { Cause, Effect, Fiber } from "effect"

import type { AutomationReport } from "../../automations/runner.ts"

/** One owned outbound/inbound chat gateway, including while connecting. */
export interface GatewayRuntime {
  readonly id: string
  startEffect(): Effect.Effect<void, unknown>
  reportEffect(report: AutomationReport): Effect.Effect<void, unknown>
  stopEffect(): Effect.Effect<void, unknown>
}

/**
 * Own the gateway for the host lifetime without delaying HTTP startup.
 * SDK login promises cannot safely be interrupted. Shutdown waits for settlement;
 * the host's process deadline is the hard boundary for an SDK that never settles.
 */
export class GatewayConnection {
  private status: "connecting" | "ready" | "failed" = "connecting"
  private readonly startup: Fiber.Fiber<void>

  constructor(private readonly gateway: GatewayRuntime) {
    this.startup = Effect.runFork(
      Effect.suspend(() => gateway.startEffect()).pipe(
        Effect.map(() => {
          this.status = "ready"
          console.log(`[gateway:${gateway.id}] connected`)
        }),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            this.status = "failed"
            console.error(
              `[gateway:${gateway.id}] startup failed:`,
              Cause.squash(cause),
            )
          }),
        ),
        Effect.uninterruptible,
      ),
    )
  }

  get state() {
    return this.status
  }

  reportEffect(report: AutomationReport): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      if (this.status === "ready") return this.gateway.reportEffect(report)
      console.warn(
        `[gateway:${this.gateway.id}] ${this.status}; report not delivered`,
      )
      return Effect.void
    })
  }

  stopEffect(): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      yield* Fiber.await(this.startup)
      yield* this.gateway.stopEffect()
    })
  }
}

/** Platform adapters own channel authorization and message delivery. */
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
