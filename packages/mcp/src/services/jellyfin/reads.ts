import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../../config.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  objectField,
  objectList,
  pick,
  pickOrNull,
  type JsonObject,
} from "../../json.ts"
import { toolCheck, toolFail, type ToolFailure } from "../../tools/errors.ts"
import { resource } from "../../tools/reads.ts"
import {
  fittingCount,
  listResult,
  MAX_LIST_ITEMS,
} from "../../tools/results.ts"
import {
  itemKey,
  jellyfinRequest,
  LIST_FIELDS,
  MEDIA_FIELDS,
  queryItems,
  readItem,
  readItems,
  readUserItem,
} from "./client.ts"
import { clip, clipStrings, compactItem, itemLabel } from "./compact.ts"
import { itemDetail, NOT_RETURNED, userViewOf } from "./detail.ts"
import { itemsResult, mediaStart } from "./media.ts"
import {
  itemIdParam,
  providerIdParam,
  providerParam,
  userIdParam,
} from "./params.ts"
import {
  compactCandidate,
  REMATCH_TYPES,
  rematchType,
  remoteSearch,
  type SearchSeed,
} from "./rematch.ts"
import { compactUser } from "./users.ts"

/** What `item_detail` asks for beyond the fields Jellyfin always sends. */
const DETAIL_FIELDS =
  "People,Overview,Taglines,Genres,Tags,Studios,ProviderIds,Path,ParentId,OriginalTitle,SortName,DateCreated,DateLastMediaAdded,Settings,CustomRating"

/** A remote search asks every metadata provider of the item's library. */
const SEARCH_TIMEOUT_MS = 60_000

const LIBRARY_ITEM_TYPES = [
  "Movie",
  "Series",
  "Season",
  "Episode",
  "BoxSet",
] as const

export function jellyfinReads(cfg: ServiceConfig) {
  return {
    search: resource({
      description: "Find library items by name",
      params: Type.Object({
        term: Type.String({ minLength: 1 }),
        includeItemTypes: Type.Optional(
          Type.Array(Type.Enum(LIBRARY_ITEM_TYPES), { minItems: 1 }),
        ),
      }),
      run: (params, signal) =>
        queryItems(
          cfg,
          {
            searchTerm: params.term,
            Recursive: true,
            IncludeItemTypes: params.includeItemTypes?.join(","),
            Fields: LIST_FIELDS,
            Limit: MAX_LIST_ITEMS,
          },
          signal,
        ).pipe(
          Effect.map((result) =>
            listResult(result.items.map(compactItem), { total: result.total }),
          ),
        ),
    }),
    items: resource({
      description:
        "Items by id with path, location type, provider ids, media sources, and streams. " +
        "notReturned names every requested id Jellyfin has no item for. A null field is one Jellyfin did not send, not a finding that it is absent. " +
        "An item whose media does not fit one result is listed alone as far as it fits and carries mediaNext: read that id again by itself with those two values for the rest",
      params: Type.Object({
        ids: Type.Array(itemIdParam, { minItems: 1, maxItems: 50 }),
        mediaSourceIndex: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "With one id only: list its media sources from this one on; an item's mediaNext",
          }),
        ),
        streamStartIndex: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "With mediaSourceIndex: skip this many streams of that source; an item's mediaNext",
          }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const start = yield* toolCheck(() => mediaStart(params))
          const found = yield* readItems(cfg, params.ids, MEDIA_FIELDS, signal)
          return yield* toolCheck(() => itemsResult(params.ids, found, start))
        }),
    }),
    item_detail: resource({
      description:
        "One item's metadata for diagnosis: identity, provider ids, dates, status, ratings, genres, tags, lock state, and its cast and crew in Jellyfin's order with repeated entries kept. " +
        "With userId, also whether Jellyfin returns the item to that user and their played state, progress, favorite flag, and child counts. " +
        "A null field is one Jellyfin did not send",
      params: Type.Object({
        itemId: itemIdParam,
        userId: Type.Optional(userIdParam),
        peopleStartIndex: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Skip this many People entries; People.nextStartIndex",
          }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const userId = params.userId
          // Only the read without a user proves the item exists.
          const [item, userView] = yield* Effect.all(
            [
              readItem(cfg, params.itemId, signal, { fields: DETAIL_FIELDS }),
              userId === undefined
                ? Effect.succeed(undefined)
                : readUserItem(cfg, params.itemId, userId, signal).pipe(
                    Effect.map((seen) => userViewOf(userId, seen)),
                  ),
            ],
            { concurrency: "unbounded" },
          )
          return yield* toolCheck(() =>
            itemDetail(item, params.peopleStartIndex ?? 0, userView),
          )
        }),
    }),
    children: resource({
      description:
        "Direct children of a library, series, or season as Jellyfin lists them, each with IndexNumber and LocationType. Virtual is a placeholder without a file. " +
        "With userId, the children Jellyfin returns to that user, with their played state: a series then lists no season without a file unless the user displays missing episodes",
      params: Type.Object({
        parentId: itemIdParam,
        userId: Type.Optional(userIdParam),
        startIndex: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "The nextStartIndex of a truncated result",
          }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const userId = params.userId
          if (userId !== undefined) {
            // Under an API key Jellyfin lists a parent's children for any
            // user without checking that the user may see the parent.
            const parent = yield* readUserItem(
              cfg,
              params.parentId,
              userId,
              signal,
            )
            if (parent === undefined) {
              // Fails here when the parent does not exist for anyone.
              yield* readItem(cfg, params.parentId, signal)
              return {
                userView: {
                  userId,
                  parentReturned: false,
                  meaning: NOT_RETURNED,
                },
              }
            }
          }
          const result = yield* queryItems(
            cfg,
            {
              ParentId: itemKey(params.parentId),
              userId: userId === undefined ? undefined : itemKey(userId),
              Fields: LIST_FIELDS,
              // Jellyfin sorts a series' seasons by name whatever is asked.
              SortBy: "ParentIndexNumber,IndexNumber,SortName",
              StartIndex: params.startIndex,
              Limit: MAX_LIST_ITEMS,
            },
            signal,
          ).pipe(
            Effect.catchTag(
              "HttpError",
              (error): Effect.Effect<never, ToolFailure> =>
                // An unknown parent answers 400 with no reason.
                error.status === 400
                  ? readItem(cfg, params.parentId, signal).pipe(
                      Effect.flatMap(() => Effect.fail(error)),
                    )
                  : Effect.fail(error),
            ),
          )
          const start = params.startIndex ?? 0
          const items = result.items.map((item) => ({
            ...compactItem(item),
            ...(userId !== undefined
              ? {
                  UserData: clipStrings(
                    pickOrNull(objectField(item, "UserData"), [
                      "Played",
                      "PlaybackPositionTicks",
                      "UnplayedItemCount",
                      "IsFavorite",
                    ]),
                  ),
                }
              : {}),
          }))
          // A season of long paths outgrows one result, so the page ends at
          // the last child that fits.
          const withCount = (count: number): JsonObject => ({
            ...(userId !== undefined
              ? { userView: { userId, parentReturned: true } }
              : {}),
            total: result.total,
            listed: count,
            ...(start > 0 ? { startIndex: start } : {}),
            ...(start + count < result.total
              ? { truncated: true, nextStartIndex: start + count }
              : {}),
            items: items.slice(0, count),
          })
          return yield* toolCheck(() =>
            withCount(
              fittingCount(items.length, withCount, {
                entry: `the child at startIndex ${start}`,
              }),
            ),
          )
        }),
    }),
    by_provider_id: resource({
      description:
        "Items of one type whose provider id matches, e.g. Tmdb 603 for a Movie",
      params: Type.Object({
        provider: providerParam,
        id: providerIdParam,
        itemType: Type.Enum(LIBRARY_ITEM_TYPES),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const result = yield* queryItems(
            cfg,
            {
              Recursive: true,
              IncludeItemTypes: params.itemType,
              AnyProviderIdEquals: `${params.provider}.${params.id}`,
              Fields: LIST_FIELDS,
              Limit: 200,
            },
            signal,
          )
          // The server's filter is not trusted to exist on every version.
          const matching = result.items.filter((item) =>
            Object.entries(objectField(item, "ProviderIds") ?? {}).some(
              ([provider, id]) =>
                provider.toLowerCase() === params.provider.toLowerCase() &&
                String(id) === params.id,
            ),
          )
          return {
            ...listResult(matching.map(compactItem)),
            ...(matching.length < result.items.length &&
            result.total > result.items.length
              ? {
                  warning: `this Jellyfin ignored the provider filter; only the first ${result.items.length} of ${result.total} ${params.itemType} items were checked`,
                }
              : {}),
          }
        }),
    }),
    libraries: resource({
      description: "Libraries with their type and folders on disk",
      params: Type.Object({}),
      run: (_params, signal) =>
        jellyfinRequest(cfg, "/Library/VirtualFolders", { signal }).pipe(
          Effect.map((response) =>
            listResult(
              objectList(response).map((library) =>
                pick(library, [
                  "Name",
                  "CollectionType",
                  "ItemId",
                  "Locations",
                ]),
              ),
            ),
          ),
        ),
    }),
    users: resource({
      description:
        "Users with their library access, parental controls, and audio and subtitle preferences. " +
        "Parental controls are the policy's rating limit, blocked unrated item types, blocked and allowed tags, and access schedules. " +
        "A policy without MaxParentalRating sets no rating limit",
      params: Type.Object({}),
      run: (_params, signal) =>
        jellyfinRequest(cfg, "/Users", { signal }).pipe(
          Effect.flatMap((response) =>
            toolCheck(() => listResult(objectList(response).map(compactUser))),
          ),
        ),
    }),
    sessions: resource({
      description:
        "Active sessions with what plays, the play method, and transcode reasons",
      params: Type.Object({}),
      run: (_params, signal) =>
        jellyfinRequest(cfg, "/Sessions", { signal }).pipe(
          Effect.map((response) =>
            listResult(
              objectList(response).map((session) => {
                const playing = objectField(session, "NowPlayingItem")
                return {
                  ...pick(session, [
                    "Id",
                    "UserId",
                    "UserName",
                    "Client",
                    "DeviceName",
                    "ApplicationVersion",
                    "LastActivityDate",
                  ]),
                  ...(playing ? { NowPlayingItem: compactItem(playing) } : {}),
                  PlayState: pick(objectField(session, "PlayState"), [
                    "PlayMethod",
                    "IsPaused",
                    "PositionTicks",
                    "MediaSourceId",
                    "AudioStreamIndex",
                    "SubtitleStreamIndex",
                  ]),
                  TranscodingInfo: pick(
                    objectField(session, "TranscodingInfo"),
                    [
                      "IsVideoDirect",
                      "IsAudioDirect",
                      "VideoCodec",
                      "AudioCodec",
                      "Container",
                      "TranscodeReasons",
                      "HardwareAccelerationType",
                    ],
                  ),
                }
              }),
            ),
          ),
        ),
    }),
    server_info: resource({
      description:
        "Jellyfin's version, and whether it waits for a restart, is shutting down, or has an update",
      params: Type.Object({}),
      run: (_params, signal) =>
        jellyfinRequest(cfg, "/System/Info", { signal }).pipe(
          Effect.flatMap((info) =>
            isJsonObject(info) && isString(info.Version)
              ? Effect.succeed({
                  Version: clip(info.Version, 40),
                  ...clipStrings(
                    pickOrNull(info, [
                      "ProductName",
                      "HasPendingRestart",
                      "IsShuttingDown",
                      "HasUpdateAvailable",
                    ]),
                    100,
                  ),
                })
              : toolFail("jellyfin returned no version"),
          ),
        ),
    }),
    remote_search: resource({
      description:
        "Metadata-provider match candidates for an item, by name and year or by one provider id. Queries providers and changes nothing. " +
        "With neither name nor provider id, the item's own name and year are searched",
      params: Type.Object({
        itemId: Type.Optional(itemIdParam),
        itemType: Type.Optional(
          Type.Enum(REMATCH_TYPES, {
            description: "Only without itemId; the item's own type otherwise",
          }),
        ),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        year: Type.Optional(Type.Integer({ minimum: 1870, maximum: 2200 })),
        provider: Type.Optional(providerParam),
        providerId: Type.Optional(providerIdParam),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          if (
            (params.provider === undefined) !==
            (params.providerId === undefined)
          ) {
            return yield* toolFail("pass provider and providerId together")
          }
          const item =
            params.itemId === undefined
              ? undefined
              : yield* readItem(cfg, params.itemId, signal)
          const type = item ? yield* rematchType(item) : params.itemType
          if (type === undefined) {
            return yield* toolFail(
              "pass itemId, or itemType to search without one",
            )
          }
          if (params.itemType !== undefined && params.itemType !== type) {
            return yield* toolFail(
              `itemType ${params.itemType} does not match ${item ? itemLabel(item) : "the item"}; omit it with itemId`,
            )
          }
          // A mismatched item carries the wrong provider ids, so only its
          // name and year seed the default search.
          const own = params.name === undefined && params.provider === undefined
          const name = own ? item?.Name : params.name
          const year = own ? (params.year ?? item?.ProductionYear) : params.year
          if (own && !isString(name)) {
            return yield* toolFail(
              "pass name, or provider with providerId, or the itemId of an item that has a name",
            )
          }
          const seed: SearchSeed = {
            name: isString(name) ? name : undefined,
            year: isNumber(year) ? year : undefined,
            provider: params.provider,
            providerId: params.providerId,
          }
          const found = yield* remoteSearch(
            cfg,
            type,
            seed,
            params.itemId,
            signal,
            SEARCH_TIMEOUT_MS,
          )
          return {
            searched: { itemType: type, ...pick({ ...seed }, SEED_KEYS) },
            ...listResult(found.map(compactCandidate)),
          }
        }),
    }),
  }
}

const SEED_KEYS = ["name", "year", "provider", "providerId"] as const
