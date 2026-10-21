import { Effect } from "effect"

import type { JsonObject } from "../json.ts"

/**
 * Reads kept for reuse, by key. Every write through this server drops them
 * all, since any of them may answer differently afterwards. `writeMarks`
 * moves when a write starts and when it settles, so a read that overlapped
 * one is never kept.
 */
const keptReads = new Map<
  string,
  { at: number; until: number; items: JsonObject[] }
>()
let writeMarks = 0

/**
 * Answers a list read from the copy kept under `key` while that copy is
 * younger than `maxAgeMs`, and says how old the answer is.
 */
export function keptRead<E>(
  key: string,
  maxAgeMs: number,
  read: Effect.Effect<JsonObject[], E>,
): Effect.Effect<{ items: JsonObject[]; ageMs: number }, E> {
  return Effect.suspend(() => {
    const now = Date.now()
    for (const [other, kept] of keptReads) {
      if (kept.until <= now) keptReads.delete(other)
    }
    const kept = keptReads.get(key)
    if (kept) return Effect.succeed({ items: kept.items, ageMs: now - kept.at })
    const marks = writeMarks
    return read.pipe(
      Effect.map((items) => {
        const at = Date.now()
        if (marks === writeMarks)
          keptReads.set(key, { at, until: at + maxAgeMs, items })
        return { items, ageMs: 0 }
      }),
    )
  })
}

export function dropKeptReads() {
  writeMarks += 1
  keptReads.clear()
}
