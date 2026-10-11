import { Cause, Effect, Fiber, Semaphore } from "effect"

import type { ThreadRunner } from "./agent/runner.ts"
import {
  threadKey,
  type Gateways,
  type Marker,
  type ThreadEvent,
  type ThreadRef,
} from "./gateway.ts"
import { JobStore, type Job } from "./jobs.ts"
import { SerialQueue } from "./queue.ts"
import { RevisitScheduler } from "./revisits.ts"

interface ThreadJob {
  event: ThreadEvent
  runsAhead: number
}

interface PendingRun {
  job: Job<ThreadJob>
  key: string
  status: Fiber.Fiber<Marker, unknown>
}

/** Admission, ordering, and recovery of runs, for every gateway's threads. */
export class ThreadWork {
  readonly queue = new SerialQueue()
  readonly revisits = new RevisitScheduler()

  private active: { key: string; jobId: string } | undefined
  private readonly pending = new Set<PendingRun>()
  private readonly transitions = Semaphore.makeUnsafe(1)

  constructor(
    private readonly runner: ThreadRunner,
    private readonly gateways: Gateways,
    private readonly jobs: JobStore,
  ) {}

  /** Restore accepted work before re-arming timers or opening HTTP admission. */
  restoreEffect(): Effect.Effect<void, unknown> {
    return this.transitions.withPermit(
      Effect.gen({ self: this }, function* () {
        const admitted: Job<ThreadJob>[] = []
        for (const stored of this.jobs.pending()) {
          const job = this.threadJob(stored)
          if (!job) {
            // Written by another version, or for a gateway that is gone.
            // Nothing here can run it or clean up after it.
            console.error(`[job:${stored.id}] unreadable job; dropped`)
            if (stored.status === "cancelling")
              this.jobs.markCancelled(stored.id)
            this.jobs.markFailed(stored.id, "Unreadable persisted job")
            continue
          }
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
          // A failed older cleanup still owns this thread's case projection.
          // Leave later accepted work queued for a future recovery attempt.
          if (!this.isCancelling(threadKey(job.payload.event.thread)))
            this.admit(job)
        }
      }),
    )
  }

  hasPending(thread: ThreadRef): boolean {
    const key = threadKey(thread)
    return (
      this.active?.key === key ||
      this.isCancelling(key) ||
      [...this.pending].some((pending) => pending.key === key)
    )
  }

  armRevisit(
    thread: ThreadRef,
    delayMs: number,
    reason: string,
    dueAt?: string,
  ): void {
    const key = threadKey(thread)
    if (this.isCancelling(key)) return
    this.revisits.scheduleEffect(key, delayMs, () =>
      this.enqueueEffect(
        { kind: "revisit", thread, reason },
        dueAt === undefined ? undefined : `revisit:${key}:${dueAt}`,
      ).pipe(Effect.asVoid),
    )
  }

  /** New activity in a thread replaces any revisit it was waiting on. */
  submitEffect(
    event: ThreadEvent,
  ): Effect.Effect<"cancelling" | "queued", unknown> {
    return Effect.suspend(() => {
      this.revisits.cancel(threadKey(event.thread))
      return this.enqueueEffect(event)
    })
  }

  enqueueEffect(
    event: ThreadEvent,
    requestId?: string,
  ): Effect.Effect<"cancelling" | "queued", unknown> {
    return this.transitions.withPermit(this.enqueueEvent(event, requestId))
  }

  /** The thread was closed from outside, so nothing should wake it again. */
  closedEffect(thread: ThreadRef): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      const key = threadKey(thread)
      this.revisits.cancel(key)
      return this.clearRevisit(thread).pipe(
        Effect.tap((cleared) =>
          Effect.sync(() => {
            if (cleared) console.log(`[${key}] closed; revisit dropped`)
          }),
        ),
      )
    })
  }

  private enqueueEvent(
    event: ThreadEvent,
    requestId?: string,
  ): Effect.Effect<"cancelling" | "queued", unknown> {
    return Effect.gen({ self: this }, function* () {
      const key = threadKey(event.thread)
      if (this.queue.closed)
        return yield* Effect.fail(new Error("queue is closed"))
      if (this.isCancelling(key)) {
        console.log(`[${key}] cancellation cleanup pending; event ignored`)
        return "cancelling"
      }
      const runsAhead = this.queue.size
      const job = this.jobs.create({ event, runsAhead }, requestId)
      this.admit(job)
      return "queued"
    })
  }

  private admit(job: Job<ThreadJob>): void {
    if (job.status !== "queued" && job.status !== "running") return
    if ([...this.pending].some((pending) => pending.job.id === job.id)) return
    if (this.active?.jobId === job.id) return
    const { event, runsAhead } = job.payload
    const status = Effect.runFork(
      this.jobs.actionEffect(
        job.id,
        "queue-notice",
        event.kind === "message" && runsAhead > 0
          ? this.runner.notifyQueuedEffect(event.thread, runsAhead)
          : Effect.succeed<Marker>({ id: undefined }),
      ),
    )
    const key = threadKey(event.thread)
    const pending: PendingRun = {
      job,
      key,
      status,
    }
    this.pending.add(pending)
    this.jobs.enqueue(this.queue, job, () =>
      this.run(event, pending).pipe(
        Effect.ensuring(Effect.sync(() => this.pending.delete(pending))),
      ),
    )
  }

  private run(
    event: ThreadEvent,
    pending: PendingRun,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const thread = event.thread
      const key = pending.key
      const status = yield* Fiber.join(pending.status)
      this.pending.delete(pending)
      this.active = { key, jobId: pending.job.id }
      yield* Effect.gen({ self: this }, function* () {
        const result = yield* this.runner.runEffect(
          event,
          status,
          pending.job.id,
        )
        const revisit = result.casefile.revisit
        if (!revisit) return
        this.armRevisit(thread, revisit.delayMs, revisit.reason, revisit.dueAt)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.active?.jobId === pending.job.id) this.active = undefined
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
      // Clear stale timers before cleanup can fail. Cancellation never resumes
      // model work.
      yield* this.clearRevisit(event.thread)
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
      yield* this.clearRevisit(event.thread)
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
    return this.jobs.pending().some((stored) => {
      if (stored.status !== "cancelling") return false
      const job = this.threadJob(stored)
      return job !== undefined && threadKey(job.payload.event.thread) === key
    })
  }

  /** Drops the thread's saved revisit and says whether there was one. */
  private clearRevisit(thread: ThreadRef): Effect.Effect<boolean, unknown> {
    const cases = this.gateways.cases(thread)
    return cases.loadEffect(thread.id).pipe(
      Effect.flatMap((file) => {
        if (!file.revisit) return Effect.succeed(false)
        file.revisit = undefined
        return cases.saveEffect(file).pipe(Effect.as(true))
      }),
    )
  }

  /**
   * A journal entry as a job of a gateway this host still has. The host wrote
   * the event after its gateway accepted it.
   */
  private threadJob(job: Job): Job<ThreadJob> | undefined {
    const payload = job.payload
    if (
      payload === null ||
      typeof payload !== "object" ||
      !("runsAhead" in payload) ||
      typeof payload.runsAhead !== "number" ||
      !("event" in payload) ||
      payload.event === null ||
      typeof payload.event !== "object" ||
      !("kind" in payload.event) ||
      !["message", "revisit"].includes(String(payload.event.kind)) ||
      !("thread" in payload.event)
    )
      return undefined
    const thread = payload.event.thread
    if (
      thread === null ||
      typeof thread !== "object" ||
      !("gateway" in thread) ||
      typeof thread.gateway !== "string" ||
      !("id" in thread) ||
      typeof thread.id !== "string" ||
      !this.gateways.find(thread.gateway)
    )
      return undefined
    return job as Job<ThreadJob>
  }
}
