import { Effect } from "effect"

import type { ServiceConfig } from "../../config.ts"
import {
  jsonRequestEffect,
  type JsonRequestOptions,
  type JsonValue,
  type Signal,
} from "../../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
} from "../../json.ts"
import { toolCheck, toolFail, type ToolFailure } from "../../tools/errors.ts"

export const ITEM_FIELDS = "MediaSources,Path,ProviderIds"

/**
 * Jellyfin 12 rejects the legacy X-Emby-Token header with HTTP 401 and
 * accepts the key only through the MediaBrowser Authorization scheme.
 */
export function jellyfinRequest(
  cfg: ServiceConfig,
  path: string,
  opts: JsonRequestOptions = {},
) {
  return jsonRequestEffect<JsonValue | undefined>(cfg.url, path, {
    ...opts,
    headers: { Authorization: `MediaBrowser Token="${cfg.apiKey}"` },
  })
}

/** An `/Items` query. Bare `GET /Items/{id}` answers 400 without a user. */
export function queryItems(
  cfg: ServiceConfig,
  query: NonNullable<JsonRequestOptions["query"]>,
  signal: Signal,
  timeoutMs?: number,
): Effect.Effect<{ items: JsonObject[]; total: number }, ToolFailure> {
  return jellyfinRequest(cfg, "/Items", { query, signal, timeoutMs }).pipe(
    Effect.flatMap((response) => toolCheck(() => itemPage(response))),
  )
}

/**
 * A list read is evidence of what exists, so a response that is not a list
 * with a count is an error, never an empty answer.
 */
function itemPage(response: JsonValue | undefined) {
  if (
    !isJsonObject(response) ||
    !Array.isArray(response.Items) ||
    !isNumber(response.TotalRecordCount)
  ) {
    throw new Error("jellyfin returned no item list with a total count")
  }
  const items = response.Items
  if (!items.every(isItem)) {
    throw new Error("jellyfin returned an item list entry without an Id")
  }
  return { items, total: response.TotalRecordCount }
}

function isItem(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && isString(value.Id)
}

export function itemKey(id: string): string {
  return id.replaceAll("-", "").toLowerCase()
}

/**
 * Items by id. Jellyfin 12 answers an `Ids` value it cannot parse by dropping
 * the filter and listing the library roots, so an answer is trusted only when
 * every item in it was asked for.
 */
export function readItems(
  cfg: ServiceConfig,
  ids: readonly string[],
  fields: string,
  signal: Signal,
  timeoutMs?: number,
): Effect.Effect<JsonObject[], ToolFailure> {
  const wanted = new Set(ids.map(itemKey))
  return queryItems(
    cfg,
    { Ids: [...wanted].join(","), Fields: fields },
    signal,
    timeoutMs,
  ).pipe(
    Effect.flatMap((result) =>
      result.items.every((item) => wanted.has(itemKey(String(item.Id))))
        ? Effect.succeed(result.items)
        : toolFail(
            "jellyfin answered an id lookup with items that were not asked for; its id filter did not apply",
          ),
    ),
  )
}

/** One item, read without a user, so a miss is an item that does not exist. */
export function readItem(
  cfg: ServiceConfig,
  itemId: string,
  signal: Signal,
  opts: { fields?: string; timeoutMs?: number } = {},
): Effect.Effect<JsonObject, ToolFailure> {
  return readItems(
    cfg,
    [itemId],
    opts.fields ?? ITEM_FIELDS,
    signal,
    opts.timeoutMs,
  ).pipe(
    Effect.flatMap((items) => {
      const item = items[0]
      return item
        ? Effect.succeed(item)
        : toolFail(`jellyfin has no item ${itemId}`)
    }),
  )
}

/**
 * One item as Jellyfin returns it to one user, or `undefined` when it answers
 * 404 for a user that exists. `GET /Items/{id}` with a user applies that
 * user's library access and parental rules. `GET /Items?Ids=` with a user
 * does not check library access under an API key, so it cannot answer this.
 */
export function readUserItem(
  cfg: ServiceConfig,
  itemId: string,
  userId: string,
  signal: Signal,
): Effect.Effect<JsonObject | undefined, ToolFailure> {
  return jellyfinRequest(cfg, `/Items/${itemKey(itemId)}`, {
    query: { userId: itemKey(userId) },
    signal,
  }).pipe(
    Effect.flatMap(
      (item): Effect.Effect<JsonObject | undefined, ToolFailure> =>
        isJsonObject(item) &&
        isString(item.Id) &&
        itemKey(item.Id) === itemKey(itemId)
          ? Effect.succeed(item)
          : toolFail(
              `jellyfin returned no record of item ${itemId} for user ${userId}`,
            ),
    ),
    Effect.catchTag(
      "HttpError",
      (error): Effect.Effect<JsonObject | undefined, ToolFailure> =>
        error.status === 404
          ? // An unknown user answers the same 404, so that is ruled out.
            requireUser(cfg, userId, signal).pipe(Effect.as(undefined))
          : Effect.fail(error),
    ),
  )
}

function requireUser(
  cfg: ServiceConfig,
  userId: string,
  signal: Signal,
): Effect.Effect<void, ToolFailure> {
  return jellyfinRequest(cfg, `/Users/${itemKey(userId)}`, { signal }).pipe(
    Effect.catchTag(
      "HttpError",
      (error): Effect.Effect<never, ToolFailure> =>
        error.status === 404
          ? toolFail(`jellyfin has no user ${userId}`)
          : Effect.fail(error),
    ),
    Effect.asVoid,
  )
}
