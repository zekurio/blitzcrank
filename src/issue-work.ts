import { Cause, Effect, Fiber, Semaphore } from "effect"

import {
  eventMediaScope,
  type IssueEvent,
  type IssueRunner,
} from "./agent/runner.ts"
import type { CaseStore } from "./casefile.ts"
import { JobStore, type Job } from "./jobs.ts"
import { SerialQueue } from "./queue.ts"
import { RevisitScheduler } from "./revisits.ts"
import type { StatusComment } from "./tools/index.ts"

interface IssueJob {
  event: IssueEvent
  runsAhead: number
}

interface PendingIssue {
  job: Job<IssueJob>
  issueId: string
  revision: number
  status: Fiber.Fiber<StatusComment, unknown>
  retraction: Fiber.Fiber<void, unknown> | undefined
}

export class IssueWork {
  readonly queue = new SerialQueue()
  readonly revisits = new RevisitScheduler()

  private active:
    | { issueId: string; jobId: string; controller: AbortController }
    | undefined
  private readonly pending = new Set<PendingIssue>()
  private readonly transitions = Semaphore.makeUnsafe(1)
  private readonly revisions = new Map<string, number>()

  constructor(
    private readonly runner: IssueRunner,
    private readonly cases: CaseStore,
    private readonly jobs: JobStore,
    private readonly authorizeRecovery: (
      event: IssueEvent,
    ) => Effect.Effect<boolean, unknown>,
  ) {}

  /** Restore accepted work before re-arming timers or opening HTTP admission. */
  restoreEffect(): Effect.Effect<void, unknown> {
    return this.transitions.withPermit(
      Effect.gen({ self: this }, function* () {
        const admitted: Job<IssueJob>[] = []
        for (const stored of this.jobs.pending()) {
          const job = issueJob(stored)
          if (job.status === "cancelling") {
            yield* this.recoverCancellation(job)
            continue
          }
          if (
            (yield* this.cases.isPausedEffect(job.payload.event.issueId)) ||
            !(yield* this.authorizeRecovery(job.payload.event))
          ) {
            this.jobs.requestCancel(job.id)
            yield* this.recoverCancellation(job)
            continue
          }
          admitted.push(job)
        }
        for (const job of admitted) {
          // A failed older cleanup still owns this issue's case projection.
          // Leave later accepted work queued for a future recovery attempt.
          if (!this.isCancelling(job.payload.event.issueId)) this.admit(job)
        }
      }),
    )
  }

  hasPending(issueId: string): boolean {
    return (
      this.active?.issueId === issueId ||
      this.isCancelling(issueId) ||
      [...this.pending].some((pending) => pending.issueId === issueId)
    )
  }

  armRevisit(
    issueId: string,
    delayMs: number,
    reason: string,
    mediaScope: ReturnType<typeof eventMediaScope>,
    dueAt?: string,
  ): void {
    if (this.isCancelling(issueId)) return
    this.revisits.scheduleEffect(issueId, delayMs, () =>
      this.enqueueEffect(
        { kind: "revisit", issueId, reason, mediaScope },
        dueAt === undefined ? undefined : `revisit:${issueId}:${dueAt}`,
      ).pipe(Effect.asVoid),
    )
  }

  enqueueEffect(
    event: IssueEvent,
    requestId?: string,
  ): Effect.Effect<"paused" | "queued", unknown> {
    return this.transitions.withPermit(this.enqueueEvent(event, requestId))
  }

  stopEffect(issueId: string): Effect.Effect<void, unknown> {
    return this.transitions.withPermit(this.stopIssue(issueId))
  }

  resumeEffect(issueId: string): Effect.Effect<void, unknown> {
    return this.transitions.withPermit(
      this.cases
        .resumeEffect(issueId)
        .pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              console.log(`[issue:${issueId}] resumed by Seerr command`),
            ),
          ),
        ),
    )
  }

  private enqueueEvent(
    event: IssueEvent,
    requestId?: string,
  ): Effect.Effect<"paused" | "queued", unknown> {
    return Effect.gen({ self: this }, function* () {
      if (this.queue.closed)
        return yield* Effect.fail(new Error("queue is closed"))
      if (yield* this.cases.isPausedEffect(event.issueId)) {
        console.log(`[issue:${event.issueId}] paused; event ignored`)
        return "paused"
      }
      if (this.isCancelling(event.issueId)) {
        console.log(
          `[issue:${event.issueId}] cancellation cleanup pending; event ignored`,
        )
        return "paused"
      }
      // Shutdown may close admission while the pause marker is being read.
      if (this.queue.closed)
        return yield* Effect.fail(new Error("queue is closed"))
      const runsAhead = this.queue.size
      const job = this.jobs.create({ event, runsAhead }, requestId)
      this.admit(job)
      return "queued"
    })
  }

  private admit(job: Job<IssueJob>): void {
    if (job.status !== "queued" && job.status !== "running") return
    if ([...this.pending].some((pending) => pending.job.id === job.id)) return
    if (this.active?.jobId === job.id) return
    const { event, runsAhead } = job.payload
    const status = Effect.runFork(
      this.jobs.actionEffect(
        job.id,
        "queue-notice",
        event.kind === "webhook" && runsAhead > 0
          ? this.runner.notifyQueuedEffect(event.issueId, runsAhead)
          : Effect.succeed<StatusComment>({ id: undefined }),
      ),
    )
    const pending: PendingIssue = {
      job,
      issueId: event.issueId,
      revision: this.revision(event.issueId),
      status,
      retraction: undefined,
    }
    this.pending.add(pending)
    this.jobs.enqueue(this.queue, job, () =>
      this.run(event, pending).pipe(
        Effect.ensuring(Effect.sync(() => this.pending.delete(pending))),
      ),
    )
  }

  private stopIssue(issueId: string): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      this.bumpRevision(issueId)
      this.revisits.cancel(issueId)
      for (const job of this.jobs.pending()) {
        if (issueJob(job).payload.event.issueId === issueId)
          this.jobs.requestCancel(job.id)
      }
      yield* this.cases.pauseEffect(issueId)
      if (this.active?.issueId === issueId) {
        this.active.controller.abort()
      }
      yield* Effect.forEach(
        [...this.pending].filter((pending) => pending.issueId === issueId),
        (pending) =>
          this.retract(pending).pipe(
            Effect.tap(() =>
              this.active?.issueId === issueId
                ? Effect.void
                : this.clearRevisit(issueId),
            ),
            Effect.tap(() =>
              Effect.sync(() => this.jobs.markCancelled(pending.job.id)),
            ),
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                this.jobs.markFailed(pending.job.id, Cause.squash(cause))
                console.error(
                  `[issue:${issueId}] failed to retract queue notice:`,
                  Cause.squash(cause),
                )
              }),
            ),
            Effect.ensuring(Effect.sync(() => this.pending.delete(pending))),
          ),
        { concurrency: "unbounded" },
      )
      // The active run owns its case file until it exits. It clears its revisit.
      if (this.active?.issueId !== issueId) yield* this.clearRevisit(issueId)
      console.log(`[issue:${issueId}] stopped by Seerr command`)
    })
  }

  private run(
    event: IssueEvent,
    pending: PendingIssue,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const status = yield* Fiber.join(pending.status)
      if (
        this.jobs.get(pending.job.id)?.status === "cancelling" ||
        (yield* this.cases.isPausedEffect(event.issueId)) ||
        pending.revision !== this.revision(event.issueId)
      ) {
        yield* this.retract(pending)
        if (this.active?.issueId !== event.issueId)
          yield* this.clearRevisit(event.issueId)
        this.jobs.markCancelled(pending.job.id)
        this.pending.delete(pending)
        return
      }
      this.pending.delete(pending)
      const controller = new AbortController()
      this.active = {
        issueId: event.issueId,
        jobId: pending.job.id,
        controller,
      }
      yield* Effect.gen({ self: this }, function* () {
        const result = yield* this.runner.runEffect(
          event,
          status,
          controller.signal,
          pending.job.id,
        )
        if (
          (yield* this.cases.isPausedEffect(event.issueId)) ||
          controller.signal.aborted ||
          pending.revision !== this.revision(event.issueId)
        ) {
          yield* this.clearRevisit(event.issueId)
          this.jobs.markCancelled(pending.job.id)
          return
        }
        const revisit = result.casefile.revisit
        if (!revisit) return
        this.armRevisit(
          result.issueId,
          revisit.delayMs,
          revisit.reason,
          revisit.mediaScope,
          revisit.dueAt,
        )
      }).pipe(
        Effect.catchCause((cause) =>
          controller.signal.aborted
            ? this.recoverCancellation(pending.job)
            : Effect.failCause(cause),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (this.active?.controller === controller) this.active = undefined
          }),
        ),
      )
    })
  }

  private recoverCancellation(
    job: Job<IssueJob>,
  ): Effect.Effect<void, unknown> {
    const event = job.payload.event
    return Effect.gen({ self: this }, function* () {
      // Clear stale timers before cleanup can fail. Cancellation never resumes
      // model work, even after a later /resume removed the pause marker.
      yield* this.clearRevisit(event.issueId)
      const status = yield* this.jobs
        .actions(job.id)
        .some((action) => action.key === "queue-notice")
        ? this.jobs.actionEffect<StatusComment, Error>(
            job.id,
            "queue-notice",
            Effect.fail(new Error("Unrecorded queue notice requires review")),
          )
        : Effect.succeed<StatusComment>({ id: undefined })
      yield* this.runner.cancelEffect(event, status, job.id)
      yield* this.clearRevisit(event.issueId)
      this.jobs.markCancelled(job.id)
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          this.jobs.markFailed(job.id, Cause.squash(cause))
          console.error(
            `[issue:${event.issueId}] cancellation cleanup requires review:`,
            Cause.squash(cause),
          )
        }),
      ),
    )
  }

  private retract(pending: PendingIssue): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      pending.retraction ??= Effect.runFork(
        Fiber.join(pending.status).pipe(
          Effect.flatMap((status) =>
            this.jobs.actionEffect(
              pending.job.id,
              "retract-notice",
              this.runner.retractStatusEffect(
                pending.issueId,
                status,
                pending.job.id,
              ),
            ),
          ),
        ),
      )
      return Fiber.join(pending.retraction)
    })
  }

  private revision(issueId: string): number {
    return this.revisions.get(issueId) ?? 0
  }

  private isCancelling(issueId: string): boolean {
    return this.jobs
      .pending()
      .some(
        (job) =>
          job.status === "cancelling" &&
          issueJob(job).payload.event.issueId === issueId,
      )
  }

  private bumpRevision(issueId: string): void {
    this.revisions.set(issueId, this.revision(issueId) + 1)
  }

  private clearRevisit(issueId: string): Effect.Effect<void, unknown> {
    return this.cases.loadEffect(issueId).pipe(
      Effect.flatMap((file) => {
        if (!file.revisit) return Effect.void
        file.revisit = undefined
        return this.cases.saveEffect(file)
      }),
    )
  }
}

function issueJob(job: Job): Job<IssueJob> {
  const payload = job.payload
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("event" in payload) ||
    !("runsAhead" in payload) ||
    typeof payload.runsAhead !== "number" ||
    payload.event === null ||
    typeof payload.event !== "object" ||
    !("issueId" in payload.event) ||
    typeof payload.event.issueId !== "string" ||
    !("kind" in payload.event) ||
    !["webhook", "revisit"].includes(String(payload.event.kind))
  )
    throw new Error(`Invalid persisted issue job ${job.id}`)
  // The host wrote this event after webhook authorization. Fields inside the
  // original webhook still pass the ordinary sanitizers and evidence gates.
  return job as Job<IssueJob>
}
