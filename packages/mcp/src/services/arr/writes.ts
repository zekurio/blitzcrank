import { Effect } from "effect"
import { Type } from "typebox"

import type { JsonValue, Signal } from "../../http.ts"
import {
  isJsonObject,
  isString,
  objectField,
  type JsonObject,
} from "../../json.ts"
import { toolFail, type ToolFailure } from "../../tools/errors.ts"
import { action, type WriteEffect } from "../../tools/writes.ts"
import {
  arrObject,
  arrPage,
  arrRequest,
  readBlocklist,
  readDownloadHandling,
  readQueue,
  type Arr,
} from "./client.ts"
import { compactBlocklistItem, compactQueueItem } from "./compact.ts"
import { findGrabRecord, findHistoryRecord } from "./history.ts"
import { itemIdOf, withItemId } from "./params.ts"
import { compactRelease } from "./releases.ts"

/** Grabbing fetches the release from its indexer and hands it to a client. */
const GRAB_TIMEOUT_MS = 60_000

/**
 * Queue statuses of a pending release: one the Arr holds back, for a delay
 * profile or an unavailable client, before any download client has it.
 */
const PENDING_STATUSES = new Set([
  "delay",
  "downloadclientunavailable",
  "fallback",
])

interface Redownload {
  searches: boolean | undefined
  detail: string
}

/**
 * Whether the Arr starts a replacement search itself once a release is marked
 * failed. It reads its own settings for that: redownload must be on, and for
 * a release that was grabbed from an interactive search, on for those too.
 * The record that is marked failed is the one whose release source counts.
 * Without that record the source is unknown.
 */
function redownloadAfterFailure(
  handling: JsonObject,
  record: JsonObject | undefined,
): Redownload {
  const enabled = handling.autoRedownloadFailed
  if (typeof enabled !== "boolean") {
    return {
      searches: undefined,
      detail:
        "this Arr reported no autoRedownloadFailed setting, so whether it searches a replacement itself is unknown; read the queue afterwards",
    }
  }
  if (!enabled) {
    return {
      searches: false,
      detail:
        "autoRedownloadFailed is off: the Arr starts no replacement search itself",
    }
  }
  if (!record) {
    return {
      searches: undefined,
      detail:
        "autoRedownloadFailed is on, but no grabbed history record of this download was found, so its release source and whether the Arr searches a replacement itself are unknown; read the queue afterwards",
    }
  }
  if (objectField(record, "data")?.releaseSource !== "InteractiveSearch") {
    return {
      searches: true,
      detail: "started by the Arr itself: autoRedownloadFailed is on",
    }
  }
  const interactive = handling.autoRedownloadFailedFromInteractiveSearch
  if (typeof interactive !== "boolean") {
    return {
      searches: undefined,
      detail:
        "this release came from an interactive search and this Arr reported no autoRedownloadFailedFromInteractiveSearch setting, so whether it searches a replacement itself is unknown; read the queue afterwards",
    }
  }
  return interactive
    ? {
        searches: true,
        detail:
          "started by the Arr itself: autoRedownloadFailed is on, for interactive-search grabs too",
      }
    : {
        searches: false,
        detail:
          "this release came from an interactive search and autoRedownloadFailedFromInteractiveSearch is off: the Arr starts no replacement search itself",
      }
}

/**
 * Whether blocklisting a queue item starts a replacement search. The Arr
 * blocklists a pending release directly. A download goes through its failed
 * download handling, which fails the download's newest grab as a history mark
 * does, and searches unless the removal skips it.
 */
function redownloadAfterRemoval(
  arr: Arr,
  item: JsonObject,
  skipRedownload: boolean,
  signal: Signal,
): Effect.Effect<Redownload, ToolFailure> {
  return Effect.gen(function* () {
    const downloadId = item.downloadId
    if (
      !isString(downloadId) &&
      PENDING_STATUSES.has(String(item.status).toLowerCase())
    ) {
      return {
        searches: false,
        detail:
          "this is a pending release no download client has yet: the Arr blocklists it directly and starts no replacement search",
      }
    }
    if (skipRedownload) {
      return {
        searches: false,
        detail:
          "skipRedownload is set: the Arr starts no replacement search itself",
      }
    }
    const [handling, grab] = yield* Effect.all(
      [
        readDownloadHandling(arr, signal),
        isString(downloadId)
          ? findGrabRecord(arr, downloadId, signal)
          : Effect.succeed(undefined),
      ],
      { concurrency: "unbounded" },
    )
    return redownloadAfterFailure(handling, grab)
  })
}

/** The writes both Arrs serve from the same endpoints. */
export function arrSharedActions(arr: Arr) {
  return {
    remove_queue_item: action({
      description: `Remove one item from the download queue. Blocklisting a download marks it failed, as ${arr.service}_mark_history_failed does, which can start a replacement search. The result says whether the Arr then searches a replacement itself, from its own redownload settings`,
      params: Type.Object({
        queueId: Type.Integer({ minimum: 1 }),
        removeFromClient: Type.Boolean({
          description:
            "true also removes the download and its data from the download client",
        }),
        blocklist: Type.Boolean({
          description:
            "Blocklist the release so it is not grabbed again. For a download this marks it failed, which can start a replacement search",
        }),
        skipRedownload: Type.Boolean({
          description:
            "With blocklist: true, true stops the Arr from searching a replacement itself. It does nothing without blocklisting",
        }),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const queue = yield* readQueue(arr, signal)
          if (params.removeFromClient && queue.records.length < queue.total) {
            return yield* toolFail(
              "the queue is truncated; cannot establish every item sharing this download before deleting it",
            )
          }
          const item = queue.records.find(
            (entry) => entry.id === params.queueId,
          )
          if (!item) {
            return yield* toolFail(
              `the ${arr.service} queue has no item ${params.queueId}; it may have finished importing or been removed`,
            )
          }
          const siblings = queue.records.filter(
            (entry) =>
              entry.id !== item.id &&
              isString(item.downloadId) &&
              entry.downloadId === item.downloadId,
          )
          const title = String(item.title ?? "untitled")
          const redownload = params.blocklist
            ? yield* redownloadAfterRemoval(
                arr,
                item,
                params.skipRedownload,
                signal,
              )
            : undefined
          const effect: WriteEffect = {
            kind: "remove",
            target: `queue item ${params.queueId}: ${title}`,
            detail: [
              `downloadId ${String(item.downloadId ?? "none")}`,
              `status ${String(item.status ?? "unknown")}/${String(item.trackedDownloadState ?? "unknown")}`,
              params.removeFromClient
                ? "also removed from the download client with its data"
                : "download and data stay in the download client",
              params.blocklist ? "release blocklisted" : "not blocklisted",
            ].join("; "),
          }
          return {
            state: { item, siblings },
            summary: `Remove queue item ${params.queueId} (${title})${params.removeFromClient ? " and delete its download" : ""}${params.blocklist ? ", blocklisting the release" : ""}`,
            effects:
              redownload?.searches === true
                ? [
                    effect,
                    {
                      kind: "search",
                      target: `a replacement for ${title}`,
                      detail: redownload.detail,
                    },
                  ]
                : [effect],
            warnings: [
              ...(redownload && redownload.searches !== true
                ? [redownload.detail]
                : []),
              ...(params.removeFromClient
                ? ["the downloaded data is deleted and cannot be recovered"]
                : []),
              ...(siblings.length > 0
                ? [
                    `${siblings.length} other queue item(s) share this download (ids ${siblings.map((entry) => String(entry.id)).join(", ")}) and lose it too`,
                  ]
                : []),
            ],
          }
        }),
      write: (params) =>
        arrRequest(arr, `/api/v3/queue/${params.queueId}`, {
          method: "DELETE",
          query: {
            removeFromClient: params.removeFromClient,
            blocklist: params.blocklist,
            ...(params.blocklist
              ? { skipRedownload: params.skipRedownload }
              : {}),
          },
        }),
      verify: (params) =>
        readQueue(arr, undefined).pipe(
          Effect.map((queue): JsonValue => {
            const left = queue.records.find(
              (entry) => entry.id === params.queueId,
            )
            if (!left) {
              if (queue.records.length < queue.total) {
                return {
                  warning: `the queue read is truncated; cannot confirm queue item ${params.queueId} is gone`,
                }
              }
              return { confirmed: `queue item ${params.queueId} is gone` }
            }
            return {
              warning: `queue item ${params.queueId} is still listed; the queue refreshes shortly after a removal, so read it again`,
              item: compactQueueItem(left),
            }
          }),
        ),
    }),
    mark_history_failed: action({
      description:
        "Mark a grabbed release failed, which blocklists it. The result says whether the Arr then searches a replacement itself, from its own redownload settings",
      params: withItemId(
        arr,
        Type.Object({
          historyId: Type.Integer({
            minimum: 1,
            description: `The release's history record, from ${arr.service}_history`,
          }),
        }),
        `The ${arr.itemNoun} the record belongs to. Needed when the record is old`,
      ),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const record = yield* findHistoryRecord(
            arr,
            params.historyId,
            itemIdOf(arr, params),
            signal,
          )
          const [queue, handling] = yield* Effect.all(
            [readQueue(arr, signal), readDownloadHandling(arr, signal)],
            { concurrency: "unbounded" },
          )
          const active = queue.records.filter(
            (entry) =>
              isString(record.downloadId) &&
              entry.downloadId === record.downloadId,
          )
          const title = String(record.sourceTitle ?? "untitled")
          const redownload = redownloadAfterFailure(handling, record)
          const effect: WriteEffect = {
            kind: "blocklist",
            target: `history record ${params.historyId}: ${title}`,
            detail: `event ${String(record.eventType ?? "unknown")}; downloadId ${String(record.downloadId ?? "none")}`,
          }
          const search: WriteEffect = {
            kind: "search",
            target: `a replacement for ${title}`,
            detail: redownload.detail,
          }
          return {
            state: { record },
            summary: `Mark ${title} failed and blocklist it`,
            effects: redownload.searches === true ? [effect, search] : [effect],
            warnings: [
              ...(redownload.searches === true ? [] : [redownload.detail]),
              ...(active.length > 0
                ? [
                    `this release is still in the queue (${active.map((entry) => `item ${String(entry.id)} ${String(entry.status ?? "")}`).join(", ")}); marking it failed discards that active download`,
                  ]
                : []),
              ...(record.eventType !== "grabbed"
                ? [
                    `record ${params.historyId} is a ${String(record.eventType)} event, not the grab; the Arr fails the grab that shares its downloadId`,
                  ]
                : []),
            ],
          }
        }),
      write: (params) =>
        arrRequest(arr, `/api/v3/history/failed/${params.historyId}`, {
          method: "POST",
        }),
      verify: (_params, _result, state) =>
        arrPage(
          arr,
          "/api/v3/blocklist",
          {
            page: 1,
            pageSize: 100,
            sortKey: "date",
            sortDirection: "descending",
          },
          undefined,
        ).pipe(
          Effect.map((page): JsonValue => {
            const entries = page.records.filter(
              (entry) => entry.sourceTitle === state.record.sourceTitle,
            )
            if (entries.length === 0) {
              return {
                warning:
                  "no blocklist entry with this release title among the newest 100 yet; read the blocklist again",
              }
            }
            return {
              confirmed: "release is blocklisted",
              entries: entries.map(compactBlocklistItem),
            }
          }),
        ),
    }),
    delete_blocklist_entry: action({
      description:
        "Remove one blocklist entry so the release can be grabbed again",
      params: Type.Object({ blocklistId: Type.Integer({ minimum: 1 }) }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const blocklist = yield* readBlocklist(arr, signal, {
            until: (candidate) => candidate.id === params.blocklistId,
          })
          const entry = blocklist.records.find(
            (candidate) => candidate.id === params.blocklistId,
          )
          if (!entry) {
            return yield* toolFail(
              `the ${arr.service} blocklist has no entry ${params.blocklistId}`,
            )
          }
          const title = String(entry.sourceTitle ?? "untitled")
          const effect: WriteEffect = {
            kind: "delete",
            target: `blocklist entry ${params.blocklistId}: ${title}`,
            detail: `blocklisted ${String(entry.date ?? "at an unknown time")}; ${String(entry.message ?? "no message")}`,
          }
          return {
            state: { entry },
            summary: `Remove ${title} from the blocklist`,
            effects: [effect],
            warnings: ["the Arr may grab this release again"],
          }
        }),
      write: (params) =>
        arrRequest(arr, `/api/v3/blocklist/${params.blocklistId}`, {
          method: "DELETE",
        }),
      verify: (params) =>
        readBlocklist(arr, undefined).pipe(
          Effect.map((blocklist): JsonValue => {
            if (
              blocklist.records.some((entry) => entry.id === params.blocklistId)
            ) {
              return {
                warning: `blocklist entry ${params.blocklistId} is still listed`,
              }
            }
            if (blocklist.records.length < blocklist.total) {
              return {
                warning: `the blocklist read is truncated; cannot confirm blocklist entry ${params.blocklistId} is gone`,
              }
            }
            return {
              confirmed: `blocklist entry ${params.blocklistId} is gone`,
            }
          }),
        ),
    }),
    grab_release: action({
      description: `Grab one release listed by ${arr.service}_releases without another indexer search. The Arr only has a release for about 30 minutes after the search that listed it`,
      params: Type.Object({
        guid: Type.String({
          minLength: 1,
          description: `guid of a release from ${arr.service}_releases`,
        }),
        indexerId: Type.Integer({
          minimum: 1,
          description: "indexerId of that same release",
        }),
      }),
      // Only the indexer is resolved. The Arr checks the guid against its own
      // release cache, about 30 minutes after the search, and rejects one it
      // no longer has.
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const indexer = yield* arrObject(
            arr,
            `/api/v3/indexer/${params.indexerId}`,
            `indexer ${params.indexerId}`,
            signal,
          )
          const effect: WriteEffect = {
            kind: "grab",
            target: `release ${params.guid}`,
            detail: `from indexer ${String(indexer.name ?? params.indexerId)}; sent to the download client`,
          }
          return {
            state: null,
            summary: `Grab release ${params.guid} from indexer ${String(indexer.name ?? params.indexerId)}`,
            effects: [effect],
            warnings: ["the release is grabbed even if the Arr rejected it"],
          }
        }),
      write: (params) =>
        arrRequest(arr, "/api/v3/release", {
          method: "POST",
          body: { guid: params.guid, indexerId: params.indexerId },
          timeoutMs: GRAB_TIMEOUT_MS,
        }).pipe(
          Effect.map((release) =>
            isJsonObject(release) ? compactRelease(release) : release,
          ),
        ),
      verify: (_params, result) =>
        readQueue(arr, undefined).pipe(
          Effect.map((queue): JsonValue => {
            const title = isJsonObject(result) ? result.title : undefined
            const queued = queue.records.filter(
              (entry) => isString(title) && entry.title === title,
            )
            if (queued.length === 0) {
              return {
                warning:
                  "the release is not in the queue yet; the queue refreshes shortly after a grab, so read it again",
              }
            }
            return {
              confirmed: "release is queued",
              items: queued.map(compactQueueItem),
            }
          }),
        ),
    }),
  }
}
