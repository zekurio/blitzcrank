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
  status: Promise<StatusComment>
  retraction: Promise<void> | undefined
}

export class IssueWork {
  readonly queue = new SerialQueue()
  readonly revisits = new RevisitScheduler()

  private active: { issueId: string; controller: AbortController } | undefined
  private readonly pending = new Set<PendingIssue>()
  private transitions: Promise<unknown> = Promise.resolve()
  private readonly revisions = new Map<string, number>()

  constructor(
    private readonly runner: Pick<
      IssueRunner,
      "notifyQueued" | "retractStatus" | "run"
    >,
    private readonly cases: CaseStore,
  ) {}

  armRevisit(
    issueId: string,
    delayMs: number,
    reason: string,
    mediaScope: ReturnType<typeof eventMediaScope>,
  ): void {
    this.revisits.schedule(issueId, delayMs, () => {
      this.enqueue({ kind: "revisit", issueId, reason, mediaScope }).catch(
        (err: unknown) => {
          console.error(`[issue:${issueId}] revisit enqueue failed:`, err)
        },
      )
    })
  }

  enqueue(event: IssueEvent): Promise<"paused" | "queued"> {
    return this.transition(() => this.enqueueEvent(event))
  }

  stop(issueId: string): Promise<void> {
    return this.transition(() => this.stopIssue(issueId))
  }

  resume(issueId: string): Promise<void> {
    return this.transition(async () => {
      await this.cases.resume(issueId)
      console.log(`[issue:${issueId}] resumed by Seerr command`)
    })
  }

  // Order webhook operations without waiting for the agent queue.
  private transition<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = this.transitions.then(operation)
    this.transitions = result.catch(() => undefined)
    return result
  }

  private async enqueueEvent(event: IssueEvent): Promise<"paused" | "queued"> {
    if (await this.cases.isPaused(event.issueId)) {
      console.log(`[issue:${event.issueId}] paused; event ignored`)
      return "paused"
    }

    const runsAhead = this.queue.size
    const status =
      event.kind === "webhook" && runsAhead > 0
        ? this.runner.notifyQueued(event.issueId, runsAhead).catch((err) => {
            console.error(
              `[issue:${event.issueId}] queue notification failed; continuing:`,
              err,
            )
            return { id: undefined }
          })
        : Promise.resolve({ id: undefined })
    const pending: PendingIssue = {
      issueId: event.issueId,
      revision: this.revision(event.issueId),
      status,
      retraction: undefined,
    }
    this.pending.add(pending)
    this.queue.enqueue(() => this.run(event, pending))
    return "queued"
  }

  private async stopIssue(issueId: string): Promise<void> {
    this.bumpRevision(issueId)
    this.revisits.cancel(issueId)
    if (this.active?.issueId === issueId) this.active.controller.abort()
    await this.cases.pause(issueId)

    await Promise.all(
      [...this.pending]
        .filter((pending) => pending.issueId === issueId)
        .map((pending) =>
          this.retract(pending).catch((err: unknown) => {
            console.error(
              `[issue:${issueId}] failed to retract queue notice:`,
              err,
            )
          }),
        ),
    )
    // The active run owns its case file until it exits. It clears its revisit.
    if (this.active?.issueId !== issueId) await this.clearRevisit(issueId)
    console.log(`[issue:${issueId}] stopped by Seerr command`)
  }

  private async run(event: IssueEvent, pending: PendingIssue): Promise<void> {
    const status = await pending.status
    if (
      (await this.cases.isPaused(event.issueId)) ||
      pending.revision !== this.revision(event.issueId)
    ) {
      await this.retract(pending)
      this.pending.delete(pending)
      return
    }

    this.pending.delete(pending)
    const controller = new AbortController()
    this.active = { issueId: event.issueId, controller }
    try {
      const result = await this.runner.run(event, status, controller.signal)
      if (
        (await this.cases.isPaused(event.issueId)) ||
        controller.signal.aborted ||
        pending.revision !== this.revision(event.issueId)
      ) {
        await this.clearRevisit(event.issueId)
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
    } catch (err) {
      if (controller.signal.aborted) {
        await this.clearRevisit(event.issueId)
        return
      }
      throw err
    } finally {
      if (this.active?.controller === controller) this.active = undefined
    }
  }

  private retract(pending: PendingIssue): Promise<void> {
    pending.retraction ??= pending.status.then((status) =>
      this.runner.retractStatus(pending.issueId, status),
    )
    return pending.retraction
  }

  private revision(issueId: string): number {
    return this.revisions.get(issueId) ?? 0
  }

  private bumpRevision(issueId: string): void {
    this.revisions.set(issueId, this.revision(issueId) + 1)
  }

  private async clearRevisit(issueId: string): Promise<void> {
    const file = await this.cases.load(issueId)
    if (!file.revisit) return
    file.revisit = undefined
    await this.cases.save(file)
  }
}
