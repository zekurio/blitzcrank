import { Cause, Effect, Fiber, Semaphore } from "effect"

import type { ThreadRunner } from "./agent/runner.ts"
import {
  threadKey,
  type Gateways,
  type Inbound,
  type Marker,
} from "./gateway.ts"
import { JobStore, type Job } from "./jobs.ts"
import { ThreadQueue } from "./queue.ts"

interface ThreadJob {
  event: Inbound
  runsAhead: number
}

interface PendingRun {
  job: Job<ThreadJob>
  key: string
  status: Fiber.Fiber<Marker, unknown>
}

/** Admission, ordering, and recovery of runs, for every gateway's threads. */
export class ThreadWork {
  readonly queue: ThreadQueue

  /** The job each busy thread is running. A thread has one at most. */
  private readonly active = new Map<string, string>()
  private readonly pending = new Set<PendingRun>()
  private readonly transitions = Semaphore.makeUnsafe(1)

  constructor(
    private readonly runner: ThreadRunner,
    private readonly gateways: Gateways,
    private readonly jobs: JobStore,
    /** How many threads may run at once. */
    maxParallelRuns: number,
  ) {
    this.queue = new ThreadQueue(maxParallelRuns)
  }

  /** Restore accepted work before opening HTTP admission. */
  restoreEffect(): Effect.Effect<void, unknown> {
    return this.transitions.withPermit(
      Effect.gen({ self: this }, function* () {
        const admitted: Job<ThreadJob>[] = []
        for (const job of this.unfinished()) {
          if (job.status === "cancelling") {
            yield* this.recoverCancellation(job)
            continue
          }
          const event = job.payload.event
          if (!(yield* this.gateways.of(event.thread).authorizeEffect(event))) {
            this.jobs.requestCancel(job.id)
            yield* this.recoverCancellation(job)
            continue
          }
          admitted.push(job)
        }
        for (const job of admitted) {
          // A failed older cleanup still owns this thread's status message.
          // Leave later accepted work queued for a future recovery attempt.
          if (!this.isCancelling(threadKey(job.payload.event.thread)))
            this.admit(job)
        }
      }),
    )
  }

  enqueueEffect(
    event: Inbound,
  ): Effect.Effect<"cancelling" | "queued", unknown> {
    return this.transitions.withPermit(
      Effect.gen({ self: this }, function* () {
        const key = threadKey(event.thread)
        if (this.queue.closed)
          return yield* Effect.fail(new Error("queue is closed"))
        if (this.isCancelling(key)) {
          console.log(`[${key}] cancellation cleanup pending; event ignored`)
          return "cancelling"
        }
        const runsAhead = this.queue.ahead(key)
        this.admit(this.jobs.create({ event, runsAhead }))
        return "queued"
      }),
    )
  }

  private admit(job: Job<ThreadJob>): void {
    if (job.status !== "queued" && job.status !== "running") return
    if ([...this.pending].some((pending) => pending.job.id === job.id)) return
    if ([...this.active.values()].includes(job.id)) return
    const { event, runsAhead } = job.payload
    const status = Effect.runFork(
      this.jobs.actionEffect(
        job.id,
        "queue-notice",
        runsAhead > 0
          ? this.runner.notifyQueuedEffect(event.thread, runsAhead)
          : Effect.succeed<Marker>({ id: undefined }),
      ),
    )
    const key = threadKey(event.thread)
    const pending: PendingRun = { job, key, status }
    this.pending.add(pending)
    this.jobs.enqueue(this.queue.lane(key), job, () =>
      this.run(event, pending).pipe(
        Effect.ensuring(Effect.sync(() => this.pending.delete(pending))),
      ),
    )
  }

  private run(
    event: Inbound,
    pending: PendingRun,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const status = yield* Fiber.join(pending.status)
      this.pending.delete(pending)
      this.active.set(pending.key, pending.job.id)
      yield* this.runner.runEffect(event, status, pending.job.id).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.active.get(pending.key) === pending.job.id)
              this.active.delete(pending.key)
          }),
        ),
      )
    })
  }

  private recoverCancellation(
    job: Job<ThreadJob>,
  ): Effect.Effect<void, unknown> {
    const event = job.payload.event
    return Effect.gen({ self: this }, function* () {
      // Cancellation never resumes model work.
      const status = yield* this.jobs
        .actions(job.id)
        .some((action) => action.key === "queue-notice")
        ? this.jobs.actionEffect<Marker, Error>(
            job.id,
            "queue-notice",
            Effect.fail(new Error("Unrecorded queue notice requires review")),
          )
        : Effect.succeed<Marker>({ id: undefined })
      yield* this.runner.cancelEffect(event, status, job.id)
      this.jobs.markCancelled(job.id)
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          this.jobs.markFailed(job.id, Cause.squash(cause))
          console.error(
            `[${threadKey(event.thread)}] cancellation cleanup requires review:`,
            Cause.squash(cause),
          )
        }),
      ),
    )
  }

  private isCancelling(key: string): boolean {
    return this.unfinished().some(
      (job) =>
        job.status === "cancelling" &&
        threadKey(job.payload.event.thread) === key,
    )
  }

  /** Accepted jobs that have not ended, oldest first. */
  private unfinished(): Job<ThreadJob>[] {
    // SAFETY: This host is the journal's only writer, and `enqueueEffect`
    // writes nothing but thread jobs. State from another version is not
    // supported.
    return this.jobs.pending() as Job<ThreadJob>[]
  }
}
