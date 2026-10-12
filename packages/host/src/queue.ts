import { Cause, Effect, Fiber, Latch } from "effect"

import { errorKind, logEvent } from "./log.ts"

/** Where a task for one thread is put. */
export interface Lane {
  readonly closed: boolean
  enqueueEffect(task: () => Effect.Effect<void, unknown>): void
}

/**
 * Runs a thread's tasks one at a time and up to `limit` threads at once. A
 * thread's conversation and visible message each assume one writer, so a
 * thread never has two runs. Different threads share nothing a run writes and
 * do not wait for each other.
 *
 * A task starts as soon as its thread is idle and a slot is free, oldest
 * first. A task waiting for its own thread holds no slot.
 */
export class ThreadQueue {
  /** Threads with a task running. One each, so this is also the run count. */
  private readonly running = new Set<string>()
  /** Tasks that have not started, in arrival order. */
  private readonly waiting: { key: string; turn: Latch.Latch }[] = []
  private readonly fibers = new Set<Fiber.Fiber<void>>()
  private accepting = true

  constructor(private readonly limit: number) {}

  /** Tasks running or waiting, across every thread. */
  get size(): number {
    return this.fibers.size
  }

  get closed(): boolean {
    return !this.accepting
  }

  /** How many earlier tasks stand between a new task for `key` and its start. */
  ahead(key: string): number {
    const own =
      (this.running.has(key) ? 1 : 0) +
      this.waiting.filter((entry) => entry.key === key).length
    if (own === 0 && this.running.size < this.limit) return 0
    return Math.max(
      own,
      this.waiting.length + this.running.size - this.limit + 1,
    )
  }

  lane(key: string): Lane {
    const closed = () => this.closed
    return {
      get closed() {
        return closed()
      },
      enqueueEffect: (task) => this.enqueueEffect(key, task),
    }
  }

  enqueueEffect(key: string, task: () => Effect.Effect<void, unknown>): void {
    if (!this.accepting) throw new Error("queue is closed")
    const turn = Latch.makeUnsafe(false)
    this.waiting.push({ key, turn })
    const fiber = Effect.runFork(
      Effect.suspend(task).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.running.delete(key)
            this.startWaiting()
          }),
        ),
        Latch.whenOpen(turn),
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            logEvent(
              "queue.failed",
              { thread: key, error: errorKind(Cause.squash(cause)) },
              "error",
            ),
          ),
        ),
      ),
    )
    this.fibers.add(fiber)
    fiber.addObserver(() => this.fibers.delete(fiber))
    this.startWaiting()
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

  private startWaiting(): void {
    while (this.running.size < this.limit) {
      const next = this.waiting.find((entry) => !this.running.has(entry.key))
      if (!next) return
      this.waiting.splice(this.waiting.indexOf(next), 1)
      this.running.add(next.key)
      Latch.openUnsafe(next.turn)
    }
  }
}
