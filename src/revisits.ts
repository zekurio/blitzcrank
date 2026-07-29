import type { CaseFile, CaseMediaScope, PendingRevisit } from "./casefile.js"

/**
 * In-process revisit scheduler. One pending revisit per issue; a new webhook
 * event for the same issue cancels the pending revisit (the reporter's
 * activity wakes the issue anyway).
 *
 * Timers are in-process, but the plan behind them is persisted in the issue's
 * case file, so a restart re-arms them instead of silently dropping follow-ups.
 */
export class RevisitScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  schedule(issueId: string, delayMs: number, run: () => void): void {
    this.cancel(issueId)
    const timer = setTimeout(() => {
      this.timers.delete(issueId)
      run()
    }, delayMs)
    timer.unref?.()
    this.timers.set(issueId, timer)
  }

  cancel(issueId: string): void {
    const timer = this.timers.get(issueId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(issueId)
    }
  }

  get pending(): number {
    return this.timers.size
  }
}

export interface RevisitPlanInput {
  requestedMs: number | undefined
  reason: string | undefined
  mediaScope: CaseMediaScope
  /** The chain this run belongs to: a revisit run continues its chain. */
  previous: PendingRevisit | undefined
  isRevisitRun: boolean
  /** Whether this run produced anything the reporter or services can see. */
  producedNews: boolean
  maxChain: number
  now: number
}

/**
 * Longest follow-up delay, matching the directive clamp. Beyond ~24.8 days a
 * setTimeout overflows and fires immediately, which would turn the anti-poll
 * backoff into a tight poll.
 */
const MAX_DELAY_MS = 48 * 60 * 60 * 1000

/**
 * Self-scheduled follow-ups allowed between two user messages. A revisit is
 * the only run nobody asked for, so it is the only loop that can spend without
 * a human in it; after this many the agent must resolve or ask the reporter.
 */
export const MAX_REVISIT_CHAIN = 3

export interface RevisitPlan {
  revisit: PendingRevisit | undefined
  /** Why a requested revisit was refused, for the log. */
  refused: string | undefined
}

/**
 * Decides whether the agent's requested follow-up is actually armed.
 *
 * Two hard limits, because a wrong hypothesis that keeps "almost resolving"
 * chains $1-2 runs indefinitely:
 *  - at most `maxChain` revisits between user messages; after that the agent
 *    must resolve or ask the reporter (the prompt is told the remaining
 *    budget, so it can word the question itself),
 *  - a revisit run that produced no comment and no mutation at least doubles
 *    the next delay, so a fruitless follow-up cannot poll every 30 minutes.
 */
export function planRevisit(input: RevisitPlanInput): RevisitPlan {
  if (input.requestedMs === undefined || !input.reason) {
    return { revisit: undefined, refused: undefined }
  }
  const chain = (input.isRevisitRun ? (input.previous?.chain ?? 0) : 0) + 1
  if (chain > input.maxChain) {
    return {
      revisit: undefined,
      refused: `revisit chain limit ${input.maxChain} reached; not re-arming`,
    }
  }
  const floor =
    input.isRevisitRun && !input.producedNews && input.previous
      ? input.previous.delayMs * 2
      : 0
  const delayMs = Math.min(Math.max(input.requestedMs, floor), MAX_DELAY_MS)
  return {
    revisit: {
      dueAt: new Date(input.now + delayMs).toISOString(),
      reason: input.reason,
      mediaScope: input.mediaScope,
      chain,
      delayMs,
    },
    refused:
      delayMs > input.requestedMs
        ? `previous revisit produced no news; backed off to ${Math.round(delayMs / 60000)}m`
        : undefined,
  }
}

/** Delay to re-arm a persisted revisit with after a restart. */
export function revisitDelay(file: CaseFile, now: number): number | undefined {
  if (!file.revisit) return undefined
  const due = Date.parse(file.revisit.dueAt)
  if (!Number.isFinite(due)) return undefined
  // Overdue follow-ups run soon, but not all at once during boot.
  return Math.min(Math.max(due - now, 30_000), MAX_DELAY_MS)
}
