import { randomUUID } from "node:crypto"

import type { JsonValue } from "./http.ts"
import { isJsonObject, type JsonObject } from "./json.ts"

export interface StoredPlan {
  planId: string
  service: string
  action: string
  /** The validated arguments the plan was computed from. */
  params: JsonObject
  /** `undefined` for an action the contract exempts from a fingerprint. */
  fingerprint: JsonValue | undefined
  expiresAt: number
}

/** What the first apply of a plan did. Recorded once and replayed after. */
export type ApplyOutcome =
  | {
      ok: true
      result: JsonValue
      verification?: JsonValue
      verificationError?: string
    }
  | {
      ok: false
      writeOutcome: "rejected" | "unknown"
      message: string
    }

/**
 * How one apply attempt left its plan. `applied` consumes it, including when
 * the write failed: its result is unknown and must not be run again.
 * `stale` discards it. `untouched` wrote nothing and keeps it.
 */
export type ApplyAttempt =
  | { kind: "applied"; outcome: ApplyOutcome }
  | { kind: "stale"; message: string }
  | { kind: "untouched"; message: string }

export type ApplyReply =
  | { ok: true; action: string; outcome: ApplyOutcome; replayed: boolean }
  | { ok: false; action: string | undefined; message: string }

interface Entry {
  plan: StoredPlan
  outcome?: ApplyOutcome
  inFlight?: Promise<ApplyAttempt>
}

/** A script can plan in a loop; the oldest plans go first. */
const MAX_PLANS = 1000

/**
 * In-memory plans. A restart forgets them and the model plans again, which is
 * the safe direction: nothing here is ever the only record of a write.
 */
export class PlanStore {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: Omit<StoredPlan, "planId" | "expiresAt">): StoredPlan {
    this.sweep()
    const plan: StoredPlan = {
      ...input,
      planId: `${input.service}:${randomUUID()}`,
      expiresAt: this.now() + this.ttlMs,
    }
    this.entries.set(plan.planId, { plan })
    for (const [planId, entry] of this.entries) {
      if (this.entries.size <= MAX_PLANS) break
      if (!entry.inFlight) this.entries.delete(planId)
    }
    return plan
  }

  /** The action a live plan names, for the request log. */
  actionOf(planId: string): string | undefined {
    return this.entries.get(planId)?.plan.action
  }

  /**
   * Runs `attempt` at most once per plan. A recorded outcome is returned
   * without running anything, and a second caller that arrives while the
   * first is still applying waits for that same attempt.
   */
  async apply(
    service: string,
    planId: string,
    attempt: (plan: StoredPlan) => Promise<ApplyAttempt>,
  ): Promise<ApplyReply> {
    this.sweep()
    const entry = this.entries.get(planId)
    if (!entry) {
      return {
        ok: false,
        action: undefined,
        message: `unknown or expired plan ${planId}; this call wrote nothing. Read the current state and plan again.`,
      }
    }
    const action = entry.plan.action
    if (entry.plan.service !== service) {
      return {
        ok: false,
        action,
        message: `plan ${planId} is a ${entry.plan.service} plan; apply it with ${entry.plan.service}_apply. Nothing was written.`,
      }
    }
    if (entry.outcome) {
      return { ok: true, action, outcome: entry.outcome, replayed: true }
    }
    if (entry.inFlight) return reply(action, await entry.inFlight, true)

    // A rejection means the attempt crashed with the write possibly sent.
    const running = attempt(entry.plan).then(
      undefined,
      (cause: unknown): ApplyAttempt => ({
        kind: "applied",
        outcome: {
          ok: false,
          writeOutcome: "unknown",
          message: `apply crashed and its write may have run: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      }),
    )
    entry.inFlight = running
    const done = await running
    delete entry.inFlight
    if (done.kind === "applied") entry.outcome = done.outcome
    if (done.kind === "stale") this.entries.delete(planId)
    return reply(action, done, false)
  }

  /** Resolves once no apply is running, so shutdown never cuts a write. */
  async settled(): Promise<void> {
    const running = [...this.entries.values()].flatMap((entry) =>
      entry.inFlight ? [entry.inFlight] : [],
    )
    await Promise.allSettled(running)
  }

  /** Lazy expiry. An apply in flight keeps its entry until it records. */
  private sweep(): void {
    const now = this.now()
    for (const [planId, entry] of this.entries) {
      if (entry.plan.expiresAt <= now && !entry.inFlight) {
        this.entries.delete(planId)
      }
    }
  }
}

function reply(
  action: string,
  attempt: ApplyAttempt,
  replayed: boolean,
): ApplyReply {
  if (attempt.kind === "applied") {
    return { ok: true, action, outcome: attempt.outcome, replayed }
  }
  return { ok: false, action, message: attempt.message }
}

/** Key order must not make two equal fingerprints differ. */
export function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const members = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
  return `{${members.join(",")}}`
}

const MAX_REPORTED_CHANGES = 8
const MAX_VALUE_CHARS = 80

/**
 * Names the fingerprint fields that differ, as `path: before -> after`.
 * Empty when the two are equal.
 */
export function fingerprintDiff(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): string[] {
  const changes = diffAt("", before, after)
  if (changes.length <= MAX_REPORTED_CHANGES) return changes
  return [
    ...changes.slice(0, MAX_REPORTED_CHANGES),
    `and ${changes.length - MAX_REPORTED_CHANGES} more`,
  ]
}

function diffAt(
  path: string,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): string[] {
  if (canonicalJson(before) === canonicalJson(after)) return []
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      return [
        `${path || "state"}: ${before.length} entries -> ${after.length} entries`,
      ]
    }
    return before.flatMap((item, index) =>
      diffAt(`${path}[${index}]`, item, after[index]),
    )
  }
  if (isJsonObject(before) && isJsonObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    return keys
      .sort()
      .flatMap((key) =>
        diffAt(path ? `${path}.${key}` : key, before[key], after[key]),
      )
  }
  return [`${path || "state"}: ${shown(before)} -> ${shown(after)}`]
}

function shown(value: JsonValue | undefined): string {
  const text = canonicalJson(value)
  if (text.length <= MAX_VALUE_CHARS) return text
  return `${text.slice(0, MAX_VALUE_CHARS)}...`
}
