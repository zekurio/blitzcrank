/**
 * In-process revisit scheduler. One pending revisit per issue; a new webhook
 * event for the same issue cancels the pending revisit (the reporter's
 * activity wakes the issue anyway).
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
