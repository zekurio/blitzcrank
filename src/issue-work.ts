import { Cause, Effect, Fiber, Semaphore } from "effect"

import {
  eventMediaScope,
  type IssueEvent,
  type IssueRunner,
} from "./agent/runner.ts"
import type { CaseStore } from "./casefile.ts"
import { SerialQueue } from "./queue.ts"
import { RevisitScheduler } from "./revisits.ts"
import type { StatusComment } from "./tools/index.ts"

interface PendingIssue {
  issueId: string
  revision: number
  status: Fiber.Fiber<StatusComment>
  retraction: Fiber.Fiber<void, unknown> | undefined
}

export class IssueWork {
  readonly queue = new SerialQueue()
  readonly revisits = new RevisitScheduler()

  private active: { issueId: string; controller: AbortController } | undefined
  private readonly pending = new Set<PendingIssue>()
  private readonly transitions = Semaphore.makeUnsafe(1)
  private readonly revisions = new Map<string, number>()

  constructor(
    private readonly runner: Pick<
      IssueRunner,
      "notifyQueuedEffect" | "retractStatusEffect" | "runEffect"
    >,
    private readonly cases: CaseStore,
  ) {}

  armRevisit(
    issueId: string,
    delayMs: number,
    reason: string,
    mediaScope: ReturnType<typeof eventMediaScope>,
  ): void {
    this.revisits.scheduleEffect(issueId, delayMs, () =>
      this.enqueueEffect({ kind: "revisit", issueId, reason, mediaScope }).pipe(
        Effect.asVoid,
      ),
    )
  }

  enqueue(event: IssueEvent): Promise<"paused" | "queued"> {
    return Effect.runPromise(this.enqueueEffect(event))
  }

  enqueueEffect(
    event: IssueEvent,
  ): Effect.Effect<"paused" | "queued", unknown> {
    return this.transitions.withPermit(this.enqueueEvent(event))
  }

  stop(issueId: string): Promise<void> {
    return Effect.runPromise(this.stopEffect(issueId))
  }

  stopEffect(issueId: string): Effect.Effect<void, unknown> {
    return this.transitions.withPermit(this.stopIssue(issueId))
  }

  resume(issueId: string): Promise<void> {
    return Effect.runPromise(this.resumeEffect(issueId))
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
  ): Effect.Effect<"paused" | "queued", unknown> {
    return Effect.gen({ self: this }, function* () {
      if (this.queue.closed)
        return yield* Effect.fail(new Error("queue is closed"))
      if (yield* this.cases.isPausedEffect(event.issueId)) {
        console.log(`[issue:${event.issueId}] paused; event ignored`)
        return "paused"
      }
      // Shutdown may close admission while the pause marker is being read.
      if (this.queue.closed)
        return yield* Effect.fail(new Error("queue is closed"))
      const runsAhead = this.queue.size
      const status = Effect.runFork(
        event.kind === "webhook" && runsAhead > 0
          ? this.runner.notifyQueuedEffect(event.issueId, runsAhead).pipe(
              Effect.catchCause((cause) => {
                console.error(
                  `[issue:${event.issueId}] queue notification failed; continuing:`,
                  Cause.squash(cause),
                )
                return Effect.succeed({ id: undefined })
              }),
            )
          : Effect.succeed({ id: undefined }),
      )
      const pending: PendingIssue = {
        issueId: event.issueId,
        revision: this.revision(event.issueId),
        status,
        retraction: undefined,
      }
      this.pending.add(pending)
      this.queue.enqueueEffect(() => this.run(event, pending))
      return "queued"
    })
  }

  private stopIssue(issueId: string): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      this.bumpRevision(issueId)
      this.revisits.cancel(issueId)
      if (this.active?.issueId === issueId) this.active.controller.abort()
      yield* this.cases.pauseEffect(issueId)
      yield* Effect.forEach(
        [...this.pending].filter((pending) => pending.issueId === issueId),
        (pending) =>
          this.retract(pending).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                console.error(
                  `[issue:${issueId}] failed to retract queue notice:`,
                  Cause.squash(cause),
                )
              }),
            ),
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
        (yield* this.cases.isPausedEffect(event.issueId)) ||
        pending.revision !== this.revision(event.issueId)
      ) {
        yield* this.retract(pending)
        this.pending.delete(pending)
        return
      }
      this.pending.delete(pending)
      const controller = new AbortController()
      this.active = { issueId: event.issueId, controller }
      yield* Effect.gen({ self: this }, function* () {
        const result = yield* this.runner.runEffect(
          event,
          status,
          controller.signal,
        )
        if (
          (yield* this.cases.isPausedEffect(event.issueId)) ||
          controller.signal.aborted ||
          pending.revision !== this.revision(event.issueId)
        ) {
          yield* this.clearRevisit(event.issueId)
          return
        }
        const revisit = result.casefile.revisit
        if (!revisit) return
        this.armRevisit(
          result.issueId,
          revisit.delayMs,
          revisit.reason,
          revisit.mediaScope,
        )
      }).pipe(
        Effect.catchCause((cause) =>
          controller.signal.aborted
            ? this.clearRevisit(event.issueId)
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

  private retract(pending: PendingIssue): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      pending.retraction ??= Effect.runFork(
        Fiber.join(pending.status).pipe(
          Effect.flatMap((status) =>
            this.runner.retractStatusEffect(pending.issueId, status),
          ),
        ),
      )
      return Fiber.join(pending.retraction)
    })
  }

  private revision(issueId: string): number {
    return this.revisions.get(issueId) ?? 0
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
