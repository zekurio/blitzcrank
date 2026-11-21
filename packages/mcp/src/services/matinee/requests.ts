import { Effect } from "effect"

import type { Signal } from "../../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  objectField,
  objectList,
  type JsonObject,
} from "../../json.ts"
import { toolFail, type ToolFailure } from "../../tools/errors.ts"
import {
  matineeRequest,
  type CatalogRef,
  type MatineeAccount,
} from "./client.ts"

/** The admin queue's lists. Only `done` is paged. */
const CURRENT_LISTS = ["waiting", "needsAttention", "onTheWay"] as const
export type RequestList = (typeof CURRENT_LISTS)[number] | "done"

const PAGE_SIZE = 100
/** How far back the arrived and declined requests are searched. */
const MAX_DONE_PAGES = 10

export interface QueueEntry {
  list: RequestList
  item: JsonObject
}

export interface QueueSearch {
  entries: QueueEntry[]
  /** Pages of arrived and declined requests read. */
  donePages: number
  /** Every arrived and declined request was searched. */
  doneComplete: boolean
  /** The search stopped once it found what it looked for. */
  stoppedAtMatch: boolean
}

export function sameRef(ref: JsonObject | undefined, wanted: CatalogRef) {
  return (
    ref?.kind === wanted.kind &&
    ref.provider === wanted.provider &&
    ref.providerId === wanted.providerId
  )
}

function readPage(
  admin: MatineeAccount,
  cursor: string | undefined,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return matineeRequest(admin, "/admin/requests", {
    query: { limit: PAGE_SIZE, cursor },
    signal,
    timeoutMs: 60_000,
  }).pipe(
    Effect.flatMap((response) =>
      isJsonObject(response)
        ? Effect.succeed(response)
        : toolFail("matinee returned no request queue"),
    ),
  )
}

/**
 * The requests in the admin queue that `matches` picks. The waiting, failed,
 * and on-the-way lists come whole with the first page; arrived and declined
 * requests are paged back, newest first, until `enough` holds or the search
 * reaches its limit.
 */
export function searchQueue(
  admin: MatineeAccount,
  matches: (item: JsonObject) => boolean,
  enough: (entries: readonly QueueEntry[]) => boolean,
  signal: Signal,
): Effect.Effect<QueueSearch, ToolFailure> {
  const walk = (
    cursor: string | undefined,
    pages: number,
    found: readonly QueueEntry[],
  ): Effect.Effect<QueueSearch, ToolFailure> =>
    Effect.gen(function* () {
      const page = yield* readPage(admin, cursor, signal)
      const current: QueueEntry[] =
        pages === 0
          ? CURRENT_LISTS.flatMap((list) =>
              objectList(page[list])
                .filter(matches)
                .map((item) => ({ list, item })),
            )
          : []
      const done: QueueEntry[] = objectList(page.done)
        .filter(matches)
        .map((item) => ({ list: "done", item }))
      const entries = [...found, ...current, ...done]
      const next = isString(page.nextCursor) ? page.nextCursor : undefined
      const read = pages + 1
      const matched = enough(entries)
      if (next === undefined || read >= MAX_DONE_PAGES || matched) {
        return {
          entries,
          donePages: read,
          doneComplete: next === undefined,
          stoppedAtMatch: matched,
        }
      }
      return yield* walk(next, read, entries)
    })
  return walk(undefined, 0, [])
}

/** One request by id, wherever it is in the queue. */
export function findRequest(
  admin: MatineeAccount,
  requestId: string,
  signal: Signal,
): Effect.Effect<QueueSearch, ToolFailure> {
  return searchQueue(
    admin,
    (item) => item.id === requestId,
    (entries) => entries.length > 0,
    signal,
  )
}

export function requestLabel(item: JsonObject): string {
  const title = objectField(item, "title")
  const year = title?.year
  return `${String(title?.name ?? "unnamed")}${isNumber(year) ? ` (${year})` : ""}`
}
