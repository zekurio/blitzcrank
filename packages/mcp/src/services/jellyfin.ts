import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import {
  jsonRequestEffect,
  type JsonRequestOptions,
  type JsonValue,
} from "../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  objectField,
  objectList,
  pick,
  type JsonObject,
} from "../json.ts"
import {
  action,
  defineReads,
  defineWrites,
  listResult,
  MAX_LIST_ITEMS,
  rawPath,
  rawResult,
  resource,
  toolFail,
  type ServerTool,
  type ToolFailure,
  type WriteEffect,
} from "../tools.ts"

type Signal = AbortSignal | undefined

const ITEM_FIELDS = "MediaSources,Path,ProviderIds"
const LIST_FIELDS = "Path,ProviderIds"
/** A rematch refreshes the item, and for a series every child, before it answers. */
const REMATCH_TIMEOUT_MS = 90_000
const MAX_OVERVIEW_CHARS = 300
const REFRESH_MODES = [
  "None",
  "ValidationOnly",
  "Default",
  "FullRefresh",
] as const

export function buildJellyfinTools(cfg: ServiceConfig): ServerTool[] {
  const service = { name: "jellyfin", label: "Jellyfin (library)" }
  return [
    ...defineReads(service, jellyfinReads(cfg)),
    ...defineWrites(service, jellyfinActions(cfg)),
  ]
}

/**
 * Jellyfin 12 rejects the legacy X-Emby-Token header with HTTP 401 and
 * accepts the key only through the MediaBrowser Authorization scheme.
 */
function jellyfinRequest(
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
function queryItems(
  cfg: ServiceConfig,
  query: NonNullable<JsonRequestOptions["query"]>,
  signal: Signal,
): Effect.Effect<{ items: JsonObject[]; total: number }, ToolFailure> {
  return jellyfinRequest(cfg, "/Items", { query, signal }).pipe(
    Effect.flatMap((response) => {
      if (!isJsonObject(response) || !Array.isArray(response.Items)) {
        return toolFail("jellyfin returned no item list")
      }
      const items = objectList(response.Items)
      return Effect.succeed({
        items,
        total: isNumber(response.TotalRecordCount)
          ? response.TotalRecordCount
          : items.length,
      })
    }),
  )
}

function readItem(
  cfg: ServiceConfig,
  itemId: string,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return queryItems(cfg, { Ids: itemId, Fields: ITEM_FIELDS }, signal).pipe(
    Effect.flatMap((result) => {
      const item = result.items[0]
      return item
        ? Effect.succeed(item)
        : toolFail(`jellyfin has no item ${itemId}`)
    }),
  )
}

function compactStream(stream: JsonObject): JsonObject {
  return pick(stream, [
    "Type",
    "Index",
    "Codec",
    "Language",
    "Title",
    "DisplayTitle",
    "IsDefault",
    "IsForced",
    "IsExternal",
    "Channels",
    "ChannelLayout",
    "Height",
    "Width",
    "VideoRange",
  ])
}

function compactItem(
  item: JsonObject,
  extra: readonly string[] = [],
): JsonObject {
  return {
    ...pick(item, [
      "Id",
      "Name",
      "Type",
      "Path",
      "ProviderIds",
      "ParentId",
      "SeriesId",
      "SeriesName",
      "SeasonId",
      "IndexNumber",
      "ParentIndexNumber",
      "ProductionYear",
      "RunTimeTicks",
      ...extra,
    ]),
    ...(Array.isArray(item.MediaSources)
      ? {
          MediaSources: objectList(item.MediaSources).map((source) => ({
            ...pick(source, ["Id", "Path", "Container", "Size", "Bitrate"]),
            MediaStreams: objectList(source.MediaStreams).map(compactStream),
          })),
        }
      : {}),
  }
}

function itemLabel(item: JsonObject): string {
  return `${String(item.Type ?? "item")} ${String(item.Name ?? "unnamed")} (${String(item.Id)})`
}

const itemIdParam = Type.String({
  minLength: 1,
  description: "Jellyfin item id",
})

function jellyfinReads(cfg: ServiceConfig) {
  return {
    search: resource({
      description: "Find library items by name",
      params: Type.Object({
        term: Type.String({ minLength: 1 }),
        includeItemTypes: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            description: "e.g. Movie, Series, Episode",
          }),
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
            listResult(
              result.items.map((item) => compactItem(item)),
              { total: result.total },
            ),
          ),
        ),
    }),
    items: resource({
      description:
        "Items by id with media sources, streams, path, and provider ids",
      params: Type.Object({
        ids: Type.Array(itemIdParam, { minItems: 1, maxItems: 50 }),
        fields: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), {
            description: `Extra item fields beyond ${ITEM_FIELDS}, e.g. Overview, DateCreated`,
          }),
        ),
      }),
      run: (params, signal) =>
        queryItems(
          cfg,
          {
            Ids: params.ids.join(","),
            Fields: [ITEM_FIELDS, ...(params.fields ?? [])].join(","),
          },
          signal,
        ).pipe(
          Effect.map((result) =>
            listResult(
              result.items.map((item) => compactItem(item, params.fields)),
            ),
          ),
        ),
    }),
    children: resource({
      description:
        "Direct children of a library, series, or season, in index order",
      params: Type.Object({
        parentId: itemIdParam,
        startIndex: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Skip this many when a result came back truncated",
          }),
        ),
      }),
      run: (params, signal) =>
        queryItems(
          cfg,
          {
            ParentId: params.parentId,
            Fields: LIST_FIELDS,
            SortBy: "ParentIndexNumber,IndexNumber,SortName",
            StartIndex: params.startIndex,
            Limit: MAX_LIST_ITEMS,
          },
          signal,
        ).pipe(
          Effect.map((result) => {
            const start = params.startIndex ?? 0
            return {
              total: result.total,
              listed: result.items.length,
              ...(start > 0 ? { startIndex: start } : {}),
              ...(start + result.items.length < result.total
                ? { truncated: true }
                : {}),
              items: result.items.map((item) => compactItem(item)),
            }
          }),
        ),
    }),
    by_provider_id: resource({
      description:
        "Items of one type whose provider id matches, e.g. Tmdb 603 for a Movie",
      params: Type.Object({
        provider: Type.String({
          minLength: 1,
          description: "Provider name: Tmdb, Tvdb, or Imdb",
        }),
        id: Type.String({ minLength: 1 }),
        itemType: Type.String({
          minLength: 1,
          description: "Movie, Series, or Episode",
        }),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const result = yield* queryItems(
            cfg,
            {
              Recursive: true,
              IncludeItemTypes: params.itemType,
              AnyProviderIdEquals: `${params.provider}.${params.id}`,
              Fields: ITEM_FIELDS,
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
            ...listResult(matching.map((item) => compactItem(item))),
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
        "Users with their library access and audio and subtitle preferences",
      params: Type.Object({}),
      run: (_params, signal) =>
        jellyfinRequest(cfg, "/Users", { signal }).pipe(
          Effect.map((response) =>
            listResult(
              objectList(response).map((user) => ({
                ...pick(user, ["Id", "Name", "LastActivityDate"]),
                Policy: pick(objectField(user, "Policy"), [
                  "IsAdministrator",
                  "IsDisabled",
                  "EnableAllFolders",
                  "EnabledFolders",
                  "EnableMediaPlayback",
                  "EnableVideoPlaybackTranscoding",
                ]),
                Configuration: pick(objectField(user, "Configuration"), [
                  "AudioLanguagePreference",
                  "PlayDefaultAudioTrack",
                  "SubtitleLanguagePreference",
                  "SubtitleMode",
                ]),
              })),
            ),
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
    user_item: resource({
      description:
        "One item as one user sees it: visibility, played state, and progress",
      params: Type.Object({
        userId: Type.String({ minLength: 1 }),
        itemId: itemIdParam,
      }),
      run: (params, signal) =>
        jellyfinRequest(cfg, `/Items/${encodeURIComponent(params.itemId)}`, {
          query: { userId: params.userId },
          signal,
        }).pipe(
          Effect.flatMap((item) =>
            isJsonObject(item)
              ? Effect.succeed({
                  ...compactItem(item),
                  UserData: pick(objectField(item, "UserData"), [
                    "Played",
                    "PlayCount",
                    "PlaybackPositionTicks",
                    "IsFavorite",
                    "LastPlayedDate",
                  ]),
                })
              : toolFail(
                  `jellyfin returned no item ${params.itemId} for that user`,
                ),
          ),
        ),
    }),
    remote_search: resource({
      description:
        "Metadata-provider match candidates for an item. Queries providers and changes nothing",
      params: Type.Object({
        itemType: Type.Enum(["Movie", "Series", "BoxSet", "Trailer"], {
          description: "The item's type",
        }),
        itemId: Type.Optional(itemIdParam),
        searchInfo: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description:
              "Name, Year, and ProviderIds to search by. Defaults to the item's own name and year",
          }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          if (params.itemId === undefined && params.searchInfo === undefined) {
            return yield* toolFail("pass itemId, searchInfo, or both")
          }
          const item =
            params.itemId === undefined
              ? undefined
              : yield* readItem(cfg, params.itemId, signal)
          // A mismatched item carries the wrong provider ids, so only its
          // name and year seed the default search.
          const searchInfo = params.searchInfo ?? {
            Name: item?.Name ?? null,
            Year: item?.ProductionYear ?? null,
          }
          const response = yield* jellyfinRequest(
            cfg,
            `/Items/RemoteSearch/${params.itemType}`,
            {
              method: "POST",
              // SAFETY: the record arrived as JSON.
              body: {
                SearchInfo: searchInfo as JsonValue,
                ...(params.itemId !== undefined
                  ? { ItemId: params.itemId }
                  : {}),
              },
              timeoutMs: 60_000,
              signal,
            },
          )
          return listResult(objectList(response).map(compactSearchResult))
        }),
    }),
    raw: resource({
      description:
        "Any other GET that answers JSON. Uncompacted; prefer a named tool",
      params: Type.Object({
        path: Type.String({
          description:
            "Service-relative path with its query string, e.g. /System/Info",
        }),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const path = yield* rawPath(params.path, "/")
          const response = yield* jellyfinRequest(cfg, path, {
            signal,
            jsonOnly: true,
          })
          return rawResult(response, [cfg.apiKey])
        }),
    }),
  }
}

/** Everything a rematch sends back, with the overview shortened. */
function compactSearchResult(result: JsonObject): JsonObject {
  return {
    ...result,
    ...(isString(result.Overview)
      ? { Overview: result.Overview.slice(0, MAX_OVERVIEW_CHARS) }
      : {}),
  }
}

function jellyfinActions(cfg: ServiceConfig) {
  return {
    refresh_item: action({
      description:
        "Refresh one item's metadata, images, and file probe. Runs in the background",
      params: Type.Object({
        itemId: itemIdParam,
        metadataRefreshMode: Type.Optional(
          Type.Enum(REFRESH_MODES, { description: "Default: Default" }),
        ),
        imageRefreshMode: Type.Optional(
          Type.Enum(REFRESH_MODES, { description: "Default: Default" }),
        ),
        replaceAllMetadata: Type.Optional(
          Type.Boolean({ description: "Discard the stored metadata first" }),
        ),
        replaceAllImages: Type.Optional(
          Type.Boolean({ description: "Discard the stored artwork first" }),
        ),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const item = yield* readItem(cfg, params.itemId, signal)
          const effect: WriteEffect = {
            kind: "refresh",
            target: itemLabel(item),
            detail: [
              `path ${String(item.Path ?? "none")}`,
              `metadata ${params.metadataRefreshMode ?? "Default"}`,
              `images ${params.imageRefreshMode ?? "Default"}`,
            ].join("; "),
          }
          return {
            state: null,
            summary: `Refresh ${itemLabel(item)}`,
            effects: [effect],
            warnings: [
              ...(params.replaceAllMetadata === true
                ? ["the stored metadata is replaced, manual edits included"]
                : []),
              ...(params.replaceAllImages === true
                ? ["the stored artwork is replaced"]
                : []),
            ],
          }
        }),
      write: (params) =>
        jellyfinRequest(
          cfg,
          `/Items/${encodeURIComponent(params.itemId)}/Refresh`,
          {
            method: "POST",
            query: {
              Recursive: true,
              MetadataRefreshMode: params.metadataRefreshMode ?? "Default",
              ImageRefreshMode: params.imageRefreshMode ?? "Default",
              ReplaceAllMetadata: params.replaceAllMetadata ?? false,
              ReplaceAllImages: params.replaceAllImages ?? false,
            },
          },
        ).pipe(
          Effect.map(
            (): JsonValue => ({
              queued: "refresh accepted; Jellyfin runs it in the background",
            }),
          ),
        ),
      verify: (params) =>
        readItem(cfg, params.itemId, undefined).pipe(
          Effect.map((item) => compactItem(item)),
        ),
    }),
    apply_remote_search: action({
      description:
        "Rematch one item to a jellyfin_remote_search candidate, replacing its provider ids and metadata",
      params: Type.Object({
        itemId: itemIdParam,
        searchResult: Type.Record(Type.String(), Type.Unknown(), {
          description: "One candidate from jellyfin_remote_search, unchanged",
        }),
        replaceAllImages: Type.Optional(
          Type.Boolean({ description: "Default true" }),
        ),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const item = yield* readItem(cfg, params.itemId, signal)
          // SAFETY: the record arrived as JSON.
          const candidate = params.searchResult as JsonObject
          const providerIds = objectField(candidate, "ProviderIds")
          if (!providerIds || Object.keys(providerIds).length === 0) {
            return yield* toolFail(
              "searchResult carries no ProviderIds; pass a candidate from jellyfin_remote_search unchanged",
            )
          }
          const effect: WriteEffect = {
            kind: "rematch",
            target: itemLabel(item),
            detail: [
              `path ${String(item.Path ?? "none")}`,
              `provider ids ${JSON.stringify(item.ProviderIds ?? {})} -> ${JSON.stringify(providerIds)}`,
              `new match ${String(candidate.Name ?? "unnamed")} (${String(candidate.ProductionYear ?? "unknown year")})`,
            ].join("; "),
          }
          return {
            state: null,
            summary: `Rematch ${itemLabel(item)} to ${String(candidate.Name ?? "unnamed")} (${String(candidate.ProductionYear ?? "unknown year")})`,
            effects: [effect],
            warnings: [
              "all metadata of the item is replaced by the new match",
              ...(item.Type === "Series"
                ? ["a series rematch also refreshes every season and episode"]
                : []),
            ],
          }
        }),
      write: (params) =>
        jellyfinRequest(
          cfg,
          `/Items/RemoteSearch/Apply/${encodeURIComponent(params.itemId)}`,
          {
            method: "POST",
            query: { ReplaceAllImages: params.replaceAllImages ?? true },
            // SAFETY: the record arrived as JSON.
            body: params.searchResult as JsonValue,
            timeoutMs: REMATCH_TIMEOUT_MS,
          },
        ).pipe(Effect.map((): JsonValue => ({ applied: "rematch accepted" }))),
      verify: (params) =>
        readItem(cfg, params.itemId, undefined).pipe(
          Effect.map((item) => compactItem(item)),
        ),
    }),
  }
}
