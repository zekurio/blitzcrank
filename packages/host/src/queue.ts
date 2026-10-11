import { Cause, Effect, Fiber, Semaphore } from "effect"

/** Serializes runs across every trigger and owns their fibers until completion. */
export class SerialQueue {
  private readonly permit = Semaphore.makeUnsafe(1)
  private readonly fibers = new Set<Fiber.Fiber<void>>()
  private accepting = true

  get size(): number {
    return this.fibers.size
  }

  get closed(): boolean {
    return !this.accepting
  }

  enqueueEffect(task: () => Effect.Effect<void, unknown>): void {
    if (!this.accepting) throw new Error("queue is closed")
    const fiber = Effect.runFork(
      Effect.suspend(task).pipe(
        Semaphore.withPermit(this.permit),
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            console.error("[queue] task failed:", Cause.squash(cause)),
          ),
        ),
      ),
    )
    this.fibers.add(fiber)
    fiber.addObserver(() => this.fibers.delete(fiber))
  }

  close(): void {
    this.accepting = false
  }

  /** Waiting never interrupts a write; shutdown owns the grace deadline. */
  drainEffect(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (this.fibers.size > 0) {
        yield* Fiber.awaitAll([...this.fibers])
      }
    })
  }
}
