/**
 * Serial task queue: issues are worked one at a time so agent runs
 * never race each other against the same services.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  get size(): number {
    return this.pending;
  }

  enqueue(task: () => Promise<void>): void {
    this.pending += 1;
    this.tail = this.tail
      .then(task)
      .catch((err) => {
        console.error("[queue] task failed:", err);
      })
      .finally(() => {
        this.pending -= 1;
      });
  }
}
