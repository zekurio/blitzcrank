import { Effect } from "effect"
import { Type } from "typebox"

import type { Signal } from "../../http.ts"
import type { JsonObject } from "../../json.ts"
import { toolCheck, toolFail, type ToolFailure } from "../../tools/errors.ts"
import { resource } from "../../tools/reads.ts"
import { fittingCount } from "../../tools/results.ts"
import { arrList, arrPage, type Arr } from "./client.ts"
import { compactHistory } from "./compact.ts"
import { itemIdOf, withItemId } from "./params.ts"

const HISTORY_SCAN_PAGE_SIZE = 500
const MAX_HISTORY_SCAN_PAGES = 10
/** A record with its formats is some 650 characters, so 30 fit one result. */
const DEFAULT_HISTORY_PAGE_SIZE = 30

/** Where a history read starts: a page, and a record within that page. */
interface HistoryStart {
  page: number
  pageSize: number
  pageOffset: number
}

/**
 * One history page from `pageOffset` on, cut to what a single result holds.
 * `records` is the whole page as the Arr has it. `next` is what reads on from
 * the last record listed: the rest of this page when it was cut, the page
 * after it when one follows. A changed `pageSize` would move the start, so
 * the rest of a cut page is addressed within the same page.
 */
function historyPage(
  start: HistoryStart,
  total: number,
  records: JsonObject[],
): JsonObject {
  const items = records.slice(start.pageOffset).map(compactHistory)
  const withCount = (count: number): JsonObject => {
    const reached = start.pageOffset + count
    const cut = reached < records.length
    const after =
      records.length === start.pageSize && start.page * start.pageSize < total
    return {
      total,
      page: start.page,
      pageSize: start.pageSize,
      ...(start.pageOffset > 0 ? { pageOffset: start.pageOffset } : {}),
      listed: count,
      ...(cut ? { truncated: true } : {}),
      ...(cut
        ? {
            next: {
              page: start.page,
              pageSize: start.pageSize,
              pageOffset: reached,
            },
          }
        : after
          ? { next: { page: start.page + 1, pageSize: start.pageSize } }
          : {}),
      items: items.slice(0, count),
    }
  }
  return withCount(
    fittingCount(items.length, withCount, {
      entry: `the history record at pageOffset ${start.pageOffset} of page ${start.page}`,
    }),
  )
}

export const historyRead = (arr: Arr) => {
  const eventNames = Object.keys(arr.eventTypes)
  return resource({
    description:
      `History, newest first. With ${arr.itemKey} it is that ${arr.itemNoun}'s whole history. ` +
      "A result carries next while more remains: pass its values with the same filters to read on",
    params: withItemId(
      arr,
      Type.Object({
        eventType: Type.Optional(Type.Enum(eventNames)),
        page: Type.Optional(Type.Integer({ minimum: 1 })),
        pageSize: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            description: `Default ${DEFAULT_HISTORY_PAGE_SIZE}. A page too long for one result is cut, and next has the rest`,
          }),
        ),
        pageOffset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Skip this many records of that page. Only from next, with its page and pageSize",
          }),
        ),
      }),
      `Internal ${arr.service} ${arr.itemNoun} id; omit for every ${arr.itemNoun}`,
    ),
    run: (params, signal) =>
      Effect.gen(function* () {
        const itemId = itemIdOf(arr, params)
        const eventType = params.eventType
        const start: HistoryStart = {
          page: params.page ?? 1,
          pageSize: params.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE,
          pageOffset: params.pageOffset ?? 0,
        }
        if (start.pageOffset >= start.pageSize) {
          return yield* toolFail(
            `pageOffset skips records within one page, so it must be below pageSize ${start.pageSize}`,
          )
        }
        if (itemId !== undefined) {
          const all = yield* arrList(arr, arr.itemHistoryPath, {
            query: { [arr.itemKey]: itemId },
            signal,
          })
          const matching = all.filter(
            (record) =>
              eventType === undefined || record.eventType === eventType,
          )
          const first = (start.page - 1) * start.pageSize
          return yield* toolCheck(() =>
            historyPage(
              start,
              matching.length,
              matching.slice(first, first + start.pageSize),
            ),
          )
        }
        const result = yield* arrPage(
          arr,
          "/api/v3/history",
          {
            page: start.page,
            pageSize: start.pageSize,
            sortKey: "date",
            sortDirection: "descending",
            eventType:
              eventType === undefined ? undefined : arr.eventTypes[eventType],
          },
          signal,
        )
        return yield* toolCheck(() =>
          historyPage(start, result.total, result.records),
        )
      }),
  })
}

/** Finds one history record. There is no history read by id. */
export function findHistoryRecord(
  arr: Arr,
  historyId: number,
  itemId: number | undefined,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return Effect.gen(function* () {
    if (itemId !== undefined) {
      const records = yield* arrList(arr, arr.itemHistoryPath, {
        query: { [arr.itemKey]: itemId },
        signal,
      })
      const record = records.find((entry) => entry.id === historyId)
      if (record) return record
      return yield* toolFail(
        `${arr.itemNoun} ${itemId} has no history record ${historyId}`,
      )
    }
    for (let page = 1; page <= MAX_HISTORY_SCAN_PAGES; page++) {
      const result = yield* arrPage(
        arr,
        "/api/v3/history",
        {
          page,
          pageSize: HISTORY_SCAN_PAGE_SIZE,
          sortKey: "date",
          sortDirection: "descending",
        },
        signal,
      )
      const record = result.records.find((entry) => entry.id === historyId)
      if (record) return record
      if (result.records.length < HISTORY_SCAN_PAGE_SIZE) {
        return yield* toolFail(
          `${arr.service} has no history record ${historyId}`,
        )
      }
    }
    return yield* toolFail(
      `history record ${historyId} is not among the newest ${MAX_HISTORY_SCAN_PAGES * HISTORY_SCAN_PAGE_SIZE} records; pass ${arr.itemKey} to look it up in that ${arr.itemNoun}'s history`,
    )
  })
}

/**
 * A download's newest `grabbed` record, the one the Arr's failed download
 * handling fails. An Arr that ignores the filters returns its newest history
 * instead, so the page is matched again here. Undefined when it holds none.
 */
export function findGrabRecord(
  arr: Arr,
  downloadId: string,
  signal: Signal,
): Effect.Effect<JsonObject | undefined, ToolFailure> {
  return arrPage(
    arr,
    "/api/v3/history",
    {
      page: 1,
      pageSize: HISTORY_SCAN_PAGE_SIZE,
      sortKey: "date",
      sortDirection: "descending",
      eventType: arr.eventTypes.grabbed,
      downloadId,
    },
    signal,
  ).pipe(
    Effect.map((page) =>
      page.records.find(
        (record) =>
          record.eventType === "grabbed" && record.downloadId === downloadId,
      ),
    ),
  )
}
