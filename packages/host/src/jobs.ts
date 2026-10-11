import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { Cause, Effect } from "effect"

import type { SerialQueue } from "./queue.ts"

export type JobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
export interface Job<T = unknown> {
  id: string
  payload: T
  createdAt: number
  status: JobStatus
  error?: string
}

export class UncertainActionError extends Error {
  constructor(jobId: string, key: string) {
    super(
      `Job ${jobId} action ${key} has an unresolved intent; operator review required`,
    )
  }
}

function json(value: unknown): string {
  const result = JSON.stringify(value)
  if (result === undefined)
    throw new Error("Journal values must be JSON serializable")
  return result
}

/** One host owns admission and execution. Ownership uses a separate database,
 * so its lifetime lock never holds a transaction on the journal itself. */
export class JobStore {
  private readonly db: DatabaseSync
  private readonly owner: DatabaseSync
  private readonly scheduled = new Set<string>()

  constructor(path: string) {
    this.owner = new DatabaseSync(`${path}.owner`)
    this.owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE")
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS jobs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        createdAt INTEGER NOT NULL, status TEXT NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS actions (
        jobId TEXT NOT NULL REFERENCES jobs(id), key TEXT NOT NULL,
        result TEXT, PRIMARY KEY(jobId, key)
      );
    `)
  }

  create<T>(payload: T, id: string = randomUUID()): Job<T> {
    const existing = this.get(id)
    if (existing) return existing as Job<T>
    this.db
      .prepare("INSERT INTO jobs(id,payload,createdAt,status) VALUES(?,?,?,?)")
      .run(id, json(payload), Date.now(), "queued")
    return this.get(id)! as Job<T>
  }

  get(id: string): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id)
    return row ? this.decode(row) : undefined
  }

  pending(): Job[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status IN ('queued', 'running', 'cancelling')
         ORDER BY sequence`,
      )
      .all()
      .map((row) => this.decode(row))
  }

  markRunning(id: string): void {
    this.mark(id, "running")
  }
  markCompleted(id: string): void {
    this.mark(id, "completed")
  }
  markFailed(id: string, error: unknown): void {
    this.mark(id, "failed", String(error))
    this.db
      .prepare("UPDATE jobs SET error=? WHERE id=? AND status='cancelling'")
      .run(String(error), id)
  }
  requestCancel(id: string): void {
    this.mark(id, "cancelling")
  }
  markCancelled(id: string): void {
    this.db
      .prepare(
        "UPDATE jobs SET status='cancelled',error=NULL WHERE id=? AND status IN ('queued','running','cancelling')",
      )
      .run(id)
  }

  enqueue(
    queue: SerialQueue,
    job: Job,
    task: () => Effect.Effect<void, unknown>,
  ): void {
    if (queue.closed) throw new Error("queue is closed")
    if (this.scheduled.has(job.id)) return
    if (!this.pending().some((pending) => pending.id === job.id)) return
    this.scheduled.add(job.id)
    queue.enqueueEffect(() =>
      Effect.suspend(() => {
        const current = this.get(job.id)
        if (
          current?.status !== "queued" &&
          current?.status !== "running" &&
          current?.status !== "cancelling"
        )
          return Effect.void
        this.markRunning(job.id)
        return Effect.suspend(task)
      }).pipe(
        Effect.tap(() => Effect.sync(() => this.markCompleted(job.id))),
        Effect.catchCause((cause) =>
          Effect.sync(() => this.markFailed(job.id, Cause.squash(cause))).pipe(
            Effect.flatMap(() => Effect.failCause(cause)),
          ),
        ),
        Effect.ensuring(Effect.sync(() => this.scheduled.delete(job.id))),
      ),
    )
  }

  actionEffect<T, E>(
    jobId: string,
    key: string,
    effect: Effect.Effect<T, E>,
    options: { replaySafe?: boolean } = {},
  ): Effect.Effect<T, E | Error> {
    return Effect.suspend<T, E | Error, never>(() => {
      if (!this.get(jobId))
        return Effect.fail(new Error(`Unknown job ${jobId}`))
      const action = this.db
        .prepare("SELECT result FROM actions WHERE jobId=? AND key=?")
        .get(jobId, key)
      if (action?.result !== null && action?.result !== undefined) {
        const recorded = JSON.parse(String(action.result)) as { value?: T }
        return Effect.succeed(recorded.value as T)
      }
      if (action && !options.replaySafe)
        return Effect.fail(new UncertainActionError(jobId, key))
      if (!action)
        this.db
          .prepare("INSERT INTO actions(jobId,key) VALUES(?,?)")
          .run(jobId, key)
      return effect.pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            this.db
              .prepare("UPDATE actions SET result=? WHERE jobId=? AND key=?")
              .run(json({ value }), jobId, key)
          }),
        ),
      )
    })
  }

  actions(jobId: string): { key: string; completed: boolean }[] {
    return this.db
      .prepare("SELECT key,result FROM actions WHERE jobId=?")
      .all(jobId)
      .map((row) => ({ key: String(row.key), completed: row.result !== null }))
  }

  close(): void {
    this.db.close()
    this.owner.close()
  }

  private mark(id: string, status: JobStatus, error?: string): void {
    this.db
      .prepare(
        "UPDATE jobs SET status=?,error=? WHERE id=? AND status IN ('queued','running')",
      )
      .run(status, error ?? null, id)
  }

  private decode(row: Record<string, unknown>): Job {
    return {
      id: String(row.id),
      payload: JSON.parse(String(row.payload)) as unknown,
      createdAt: Number(row.createdAt),
      status: String(row.status) as JobStatus,
      ...(row.error === null ? {} : { error: String(row.error) }),
    }
  }
}
