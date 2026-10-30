import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { Cause, Effect } from "effect"

import { errorKind, logEvent } from "./log.ts"

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
      -- Finished jobs stay for review, so without this every lookup of the
      -- unfinished ones would read the whole history.
      CREATE INDEX IF NOT EXISTS jobs_unfinished ON jobs(sequence)
        WHERE status IN ('queued', 'running', 'cancelling');
    `)
  }

  create<T>(payload: T, id: string = randomUUID()): Job<T> {
    const existing = this.get(id)
    if (existing) return existing as Job<T>
    this.db
      .prepare("INSERT INTO jobs(id,payload,createdAt,status) VALUES(?,?,?,?)")
      .run(id, json(payload), Date.now(), "queued")
    logEvent("job.queued", { runId: id })
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
    logEvent("job.failure", { runId: id, error: errorKind(error) }, "error")
  }
  requestCancel(id: string): void {
    this.mark(id, "cancelling")
  }
  markCancelled(id: string): void {
    const changed = this.db
      .prepare(
        "UPDATE jobs SET status='cancelled',error=NULL WHERE id=? AND status IN ('queued','running','cancelling')",
      )
      .run(id)
    if (changed.changes > 0) logEvent("job.cancelled", { runId: id })
  }

  /**
   * Runs a job's task while the job is unfinished and records how it ended.
   * A job that ended already, such as one admitted twice, does not run again.
   */
  runEffect(
    id: string,
    task: () => Effect.Effect<void, unknown>,
  ): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      const status = this.get(id)?.status
      if (
        status !== "queued" &&
        status !== "running" &&
        status !== "cancelling"
      )
        return Effect.void
      this.markRunning(id)
      return Effect.suspend(task).pipe(
        Effect.tap(() => Effect.sync(() => this.markCompleted(id))),
        Effect.catchCause((cause) =>
          Effect.sync(() => this.markFailed(id, Cause.squash(cause))).pipe(
            Effect.andThen(Effect.failCause(cause)),
          ),
        ),
      )
    })
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
        logEvent("action.replayed", { runId: jobId, action: key })
        return Effect.succeed(recorded.value as T)
      }
      if (action && !options.replaySafe) {
        logEvent(
          "action.review_required",
          { runId: jobId, action: key },
          "error",
        )
        return Effect.fail(new UncertainActionError(jobId, key))
      }
      if (!action)
        this.db
          .prepare("INSERT INTO actions(jobId,key) VALUES(?,?)")
          .run(jobId, key)
      logEvent("action.started", {
        runId: jobId,
        action: key,
        retry: Boolean(action),
      })
      return effect.pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            this.db
              .prepare("UPDATE actions SET result=? WHERE jobId=? AND key=?")
              .run(json({ value }), jobId, key)
            logEvent("action.completed", { runId: jobId, action: key })
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
    const changed = this.db
      .prepare(
        "UPDATE jobs SET status=?,error=? WHERE id=? AND status IN ('queued','running')",
      )
      .run(status, error ?? null, id)
    if (changed.changes > 0) logEvent(`job.${status}`, { runId: id })
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
