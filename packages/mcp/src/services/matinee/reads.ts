import { Effect } from "effect"
import { Type } from "typebox"

import type { Signal } from "../../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  objectField,
  objectList,
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
  catalogDetails,
  matineeList,
  matineeRecord,
  matineeRequest,
  readLibrary,
  readMediaItem,
  readTitle,
  refParams,
  segment,
  TITLE_KINDS,
  uuidParam,
  type CatalogRef,
  type MatineeAccount,
} from "./client.ts"
import {
  compactAdminRequest,
  compactAudioTrack,
  compactCatalogDetail,
  compactCatalogEntry,
  compactFile,
  compactItem,
  compactLibrary,
  compactMatch,
  compactQueue,
  compactSubtitleTrack,
  compactTask,
  compactTitle,
  compactTitleSummary,
  titleMatch,
} from "./compact.ts"
import { parseLink } from "./links.ts"
import { sameRef, searchQueue, type QueueSearch } from "./requests.ts"

/** Room a page leaves for the fields around its entries. */
const PAGE_HEADROOM_CHARS = 3_000
const MAX_TRACKS = 64
const FILE_PAGE = 100

const JOB_QUEUES = [
  "library-scan",
  "media-probe",
  "metadata",
  "thumbnails",
  "subtitle-prepare",
  "trickplay",
  "media-segments",
  "artwork",
  "subtitles",
  "subtitle-fonts",
  "avatars",
  "downloads",
  "download-copies",
  "request-dispatch",
  "request-progress",
  "request-arrival",
  "catalog",
  "title-features",
  "recommendations",
] as const

const titleIdParam = uuidParam("A Matinee title id, from matinee_search")
const libraryIdParam = uuidParam("A library id, from matinee_libraries")
const itemIdParam = uuidParam(
  "A file's id, from matinee_title or matinee_files",
)
const linkParam = Type.String({
  minLength: 1,
  maxLength: 2_000,
  description:
    "A link to a Matinee page someone pasted. Only the id is taken from its path; the link itself is never fetched",
})

const TITLE_NOTE =
  "audio and embeddedSubtitles are the streams ffprobe read inside each file. Subtitle files beside the video are not among them; matinee_tracks lists both. A file with probed false has not been probed yet, which says nothing about its tracks."

/**
 * A page of entries that fits one result, with where the next page starts.
 * The entries are cut whole, never within one.
 */
function page(
  entries: readonly JsonObject[],
  offset: number,
  total: number,
  around: JsonObject,
): JsonObject {
  const listed = entries.slice(0, MAX_LIST_ITEMS)
  const build = (count: number): JsonObject => ({
    ...around,
    total,
    offset,
    listed: count,
    ...(offset + count < total
      ? { truncated: true, nextOffset: offset + count }
      : {}),
    items: listed.slice(0, count),
  })
  return build(
    fittingCount(listed.length, build, {
      headroom: PAGE_HEADROOM_CHARS,
      entry: `the entry at offset ${offset}`,
    }),
  )
}

function exactlyOne(
  what: string,
  values: readonly unknown[],
): Effect.Effect<void, ToolFailure> {
  return values.filter((value) => value !== undefined).length === 1
    ? Effect.void
    : toolFail(`pass exactly one of ${what}`)
}

/** The title a link or an id names, and the season a link points at. */
function titleTarget(
  account: MatineeAccount,
  params: { titleId?: string | undefined; link?: string | undefined },
  signal: Signal,
): Effect.Effect<{ titleId: string; season: number | undefined }, ToolFailure> {
  return Effect.gen(function* () {
    yield* exactlyOne("titleId or link", [params.titleId, params.link])
    if (params.titleId !== undefined) {
      return { titleId: params.titleId, season: undefined }
    }
    const target = yield* toolCheck(() => parseLink(params.link ?? ""))
    if (target.kind === "title") return target
    if (target.kind === "catalog") {
      return yield* toolFail(
        `the link is Matinee's catalog page of ${target.ref.kind} ${target.ref.provider} ${target.ref.providerId}, which names a title at its provider, not one on the server: read matinee_by_provider_id with those values`,
      )
    }
    const item = yield* readMediaItem(account, target.itemId, signal)
    const title = objectField(item, "title")
    if (!isString(title?.id)) {
      return yield* toolFail(
        `the file ${target.itemId} belongs to no title yet: the scan has not grouped it`,
      )
    }
    return {
      titleId: title.id,
      season: isNumber(item.seasonNumber) ? item.seasonNumber : undefined,
    }
  })
}

function titleItems(
  account: MatineeAccount,
  titleId: string,
  season: number | null | undefined,
  signal: Signal,
): Effect.Effect<JsonObject[], ToolFailure> {
  return matineeList(
    "files",
    matineeRequest(account, `/titles/${segment(titleId)}/items`, {
      method: "POST",
      body: season === undefined ? {} : { season },
      signal,
      timeoutMs: 60_000,
    }),
  )
}

function searchResult(search: QueueSearch): JsonObject {
  return {
    matches: search.entries.map((entry) => ({
      list: entry.list,
      ...compactAdminRequest(entry.item),
    })),
    searched: search.doneComplete
      ? "every request"
      : search.stoppedAtMatch
        ? "the queue up to the match"
        : `every waiting, failed, and on-the-way request, and the ${search.donePages * 100} latest arrived or declined ones; an older one may be missed`,
  }
}

/** Which queue entries a requests read is about: one id, or one title. */
function requestMatcher(params: {
  requestId?: string | undefined
  kind?: CatalogRef["kind"] | undefined
  provider?: CatalogRef["provider"] | undefined
  providerId?: string | undefined
}): Effect.Effect<(item: JsonObject) => boolean, ToolFailure> {
  const requestId = params.requestId
  const kind = params.kind
  const provider = params.provider
  const providerId = params.providerId
  const anyRef =
    kind !== undefined || provider !== undefined || providerId !== undefined
  if (requestId !== undefined && !anyRef) {
    return Effect.succeed((item) => item.id === requestId)
  }
  if (
    requestId === undefined &&
    kind !== undefined &&
    provider !== undefined &&
    providerId !== undefined
  ) {
    const ref = { kind, provider, providerId }
    return Effect.succeed((item) =>
      sameRef(objectField(objectField(item, "title"), "ref"), ref),
    )
  }
  return toolFail("pass requestId, or kind, provider, and providerId together")
}

export function matineeReads(account: MatineeAccount) {
  return {
    search: resource({
      description:
        "Titles on the server by name, across libraries, or in one library, where the query matches folder paths too. " +
        "No match proves nothing: a title can carry another name, or not be matched yet",
      params: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 200 }),
        kind: Type.Optional(Type.Enum(TITLE_KINDS)),
        libraryId: Type.Optional(libraryIdParam),
      }),
      run: (params, signal) =>
        matineeRequest(account, "/titles/browse", {
          method: "POST",
          body: {
            query: params.query,
            limit: 50,
            ...(params.kind !== undefined ? { kind: params.kind } : {}),
            ...(params.libraryId !== undefined
              ? { libraryId: params.libraryId }
              : {}),
          },
          signal,
        }).pipe(
          Effect.flatMap((response) =>
            isJsonObject(response)
              ? Effect.succeed(
                  listResult(
                    objectList(response.items).map(compactTitleSummary),
                    {
                      total: isNumber(response.total)
                        ? response.total
                        : objectList(response.items).length,
                    },
                  ),
                )
              : toolFail("matinee returned no title list"),
          ),
        ),
    }),
    title: resource({
      description:
        "One title: its match, library-relative path, seasons, and files with what ffprobe read from each. " +
        "Pass titleId or a pasted Matinee link. season narrows the files to one season, null to those without a season number; a season link narrows to its season. " +
        "A long result lists files from offset and says where the rest start",
      params: Type.Object({
        titleId: Type.Optional(titleIdParam),
        link: Type.Optional(linkParam),
        season: Type.Optional(
          Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        ),
        offset: Type.Optional(
          Type.Integer({ minimum: 0, description: "A result's nextOffset" }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const target = yield* titleTarget(account, params, signal)
          const season =
            params.season === undefined ? target.season : params.season
          const [title, items] = yield* Effect.all(
            [
              readTitle(account, target.titleId, signal),
              titleItems(account, target.titleId, season, signal),
            ],
            { concurrency: "unbounded" },
          )
          const offset = params.offset ?? 0
          return yield* toolCheck(() =>
            page(
              items.slice(offset, offset + MAX_LIST_ITEMS).map(compactItem),
              offset,
              items.length,
              {
                title: compactTitle(title),
                ...(season !== undefined ? { season } : {}),
                note: TITLE_NOTE,
              },
            ),
          )
        }),
    }),
    tracks: resource({
      description:
        "Every audio and subtitle track of one file, subtitle files beside it included, as players get them. " +
        "Pass itemId or a pasted episode or player link. A file not probed yet is probed first, which can take a while",
      params: Type.Object({
        itemId: Type.Optional(itemIdParam),
        link: Type.Optional(linkParam),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          yield* exactlyOne("itemId or link", [params.itemId, params.link])
          const linked =
            params.link === undefined
              ? undefined
              : yield* toolCheck(() => parseLink(params.link ?? ""))
          if (linked !== undefined && linked.kind !== "item") {
            return yield* toolFail(
              "the link names a title, not one file: read matinee_title with it and pass a file's id",
            )
          }
          const itemId = linked?.itemId ?? params.itemId ?? ""
          const path = `/media/${segment(itemId)}`
          const [item, audio, subtitles] = yield* Effect.all(
            [
              readMediaItem(account, itemId, signal),
              matineeList(
                "audio tracks",
                matineeRequest(account, `${path}/audio`, {
                  signal,
                  timeoutMs: 120_000,
                }),
              ),
              matineeRequest(account, `${path}/subtitles`, {
                signal,
                timeoutMs: 120_000,
              }).pipe(
                Effect.flatMap((response) =>
                  isJsonObject(response) && Array.isArray(response.tracks)
                    ? Effect.succeed(response)
                    : toolFail("matinee returned no subtitle tracks"),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          )
          const subtitleTracks = objectList(subtitles.tracks)
          const cut =
            audio.length > MAX_TRACKS || subtitleTracks.length > MAX_TRACKS
          return {
            item: compactFile(item),
            audio: audio.slice(0, MAX_TRACKS).map(compactAudioTrack),
            subtitles: subtitleTracks
              .slice(0, MAX_TRACKS)
              .map(compactSubtitleTrack),
            audioLanguage: subtitles.audioLanguage ?? null,
            ...(cut
              ? {
                  truncated: `the file has ${audio.length} audio and ${subtitleTracks.length} subtitle tracks and ${MAX_TRACKS} of each are listed: a language not listed may be among the rest, so this result proves no track missing`,
                }
              : {}),
          }
        }),
    }),
    by_provider_id: resource({
      description:
        "What Matinee holds for a TMDB or TVDB id, as an Arr record has it. Matinee matches on a title's provider id and its stored external ids, and names only the first title that matches. " +
        "The match is a lead: confirm the title's library and path before any write. No match does not prove the title absent, since an unmatched or wrongly matched title is what hides from this read; search by name too",
      params: Type.Object(refParams),
      run: (params, signal) =>
        Effect.gen(function* () {
          const ref = {
            kind: params.kind,
            provider: params.provider,
            providerId: params.providerId,
          }
          const detail = yield* catalogDetails(account, ref, undefined, signal)
          const availability = objectField(detail, "availability")
          const titleId = availability?.libraryTitleId
          const held = isString(titleId)
            ? yield* readTitle(account, titleId, signal).pipe(
                Effect.flatMap((title) =>
                  readLibrary(account, String(title.libraryId), signal).pipe(
                    Effect.map((library) => ({ title, library })),
                  ),
                ),
              )
            : undefined
          return {
            asked: ref,
            provider: {
              ref: detail.ref ?? null,
              name: detail.name ?? null,
              year: detail.year ?? null,
              stale: detail.stale ?? null,
            },
            state: availability?.state ?? null,
            requestId: availability?.requestId ?? null,
            title: held
              ? {
                  ...titleMatch(held.title),
                  library: compactLibrary(held.library),
                }
              : null,
            caution: held
              ? "the first title Matinee matched; another title may match the same id. Compare its path with the Arr's before any write"
              : "no title on the server carries this id. That does not prove the title absent: it may be unmatched or matched wrongly",
          }
        }),
    }),
    libraries: resource({
      description:
        "Libraries with their folders, as absolute paths on the Matinee host, their metadata provider, and scan state. " +
        "A file's relativePath is below one of its library's folders. The Matinee host may mount them elsewhere than the Arrs or this server do",
      params: Type.Object({}),
      run: (_params, signal) =>
        matineeList(
          "libraries",
          matineeRequest(account, "/libraries", { signal }),
        ).pipe(
          Effect.map((libraries) => listResult(libraries.map(compactLibrary))),
        ),
    }),
    files: resource({
      description:
        "Files Matinee has in one library, by a part of their name or path, or below one folder: a file it scanned shows here even before it belongs to a title. " +
        "relativePath is below one of the library's folders, not an absolute path. A file missing here was not found by a scan yet",
      params: Type.Object({
        libraryId: libraryIdParam,
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        folder: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 500,
            description:
              "A folder below the library folder, as relativePath has it, such as a show's",
          }),
        ),
        recent: Type.Optional(
          Type.Boolean({ description: "Folders with the newest files first" }),
        ),
        offset: Type.Optional(
          Type.Integer({ minimum: 0, description: "A result's nextOffset" }),
        ),
      }),
      run: (params, signal) => {
        const offset = params.offset ?? 0
        return matineeRequest(
          account,
          `/libraries/${segment(params.libraryId)}/media`,
          {
            query: {
              query: params.query,
              folder: params.folder,
              sort: params.recent === true ? "recent" : "title",
              limit: FILE_PAGE,
              offset,
            },
            signal,
          },
        ).pipe(
          Effect.flatMap((response) =>
            isJsonObject(response) && isNumber(response.total)
              ? toolCheck(() =>
                  page(
                    objectList(response.items).map(compactFile),
                    offset,
                    isNumber(response.total) ? response.total : 0,
                    {},
                  ),
                )
              : toolFail("matinee returned no file list with a total"),
          ),
        )
      },
    }),
    requests: resource({
      description:
        "One request's delivery from the admin queue: its status, whether its send failed and with what error, its connection, progress, and diagnostics. " +
        "Pass requestId, from an availability's requestId, or a title's kind, provider, and providerId; a title can have a request in more than one library",
      params: Type.Object({
        requestId: Type.Optional(uuidParam("A request id")),
        kind: Type.Optional(refParams.kind),
        provider: Type.Optional(refParams.provider),
        providerId: Type.Optional(refParams.providerId),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const matches = yield* requestMatcher(params)
          const search = yield* searchQueue(
            account,
            matches,
            (entries) => params.requestId !== undefined && entries.length > 0,
            signal,
          )
          return searchResult(search)
        }),
    }),
    jobs: resource({
      description:
        "Matinee's job queues, such as library-scan, media-probe, metadata, and request-dispatch, with what runs, what waits, their latest failures, and the scheduled tasks that fill them. " +
        "Labels name what a job works on, often a file's path",
      params: Type.Object({
        queue: Type.Optional(Type.Enum(JOB_QUEUES)),
      }),
      run: (params, signal) =>
        matineeRecord(account, "/admin/jobs", "job overview", signal).pipe(
          Effect.map((overview) => ({
            queues: objectList(overview.queues)
              .filter(
                (queue) =>
                  params.queue === undefined || queue.id === params.queue,
              )
              .map(compactQueue),
            tasks: objectList(overview.tasks)
              .filter(
                (task) =>
                  params.queue === undefined || task.queue === params.queue,
              )
              .map(compactTask),
          })),
        ),
    }),
    matches: resource({
      description:
        "Candidates at the title's library provider for a name and year, to fix a wrong or missing match with matinee_identify_title, next to the title's current match",
      params: Type.Object({
        titleId: titleIdParam,
        query: Type.String({ minLength: 1, maxLength: 200 }),
        year: Type.Optional(Type.Integer({ minimum: 1870, maximum: 2200 })),
      }),
      run: (params, signal) =>
        Effect.all(
          [
            readTitle(account, params.titleId, signal),
            readMatches(account, params, signal),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(([title, matches]) => ({
            current: titleMatch(title),
            ...listResult(matches.map(compactMatch)),
          })),
        ),
    }),
  }
}

export function readMatches(
  account: MatineeAccount,
  params: { titleId: string; query: string; year?: number | undefined },
  signal: Signal,
): Effect.Effect<JsonObject[], ToolFailure> {
  return matineeList(
    "match candidates",
    matineeRequest(account, `/titles/${segment(params.titleId)}/matches`, {
      query: { query: params.query, year: params.year },
      signal,
      timeoutMs: 45_000,
    }),
  )
}

/**
 * The catalog as a request sees it. The account's group decides what it may
 * ask for, where a request goes, and how much of its quota is left.
 */
export function matineeCatalogReads(account: MatineeAccount) {
  return {
    catalog_search: resource({
      description:
        "Titles at the metadata provider for a name, with what the token's Matinee account may do with each: here, already requested, or open to a request",
      params: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 256 }),
        kind: Type.Optional(Type.Enum(TITLE_KINDS)),
        page: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      run: (params, signal) =>
        matineeRequest(account, "/catalog/search", {
          query: { query: params.query, kind: params.kind, page: params.page },
          signal,
          timeoutMs: 45_000,
        }).pipe(
          Effect.flatMap((response) =>
            isJsonObject(response)
              ? Effect.succeed({
                  ...listResult(
                    objectList(response.items).map(compactCatalogEntry),
                  ),
                  nextPage: response.nextPage ?? null,
                  stale: response.stale ?? null,
                })
              : toolFail("matinee returned no catalog page"),
          ),
        ),
    }),
    catalog_details: resource({
      description:
        "One title at its provider as a request would see it: the library a request goes to, its other choices, every season with what is here and what is asked for, the default seasons, and the quota of the token's Matinee account, which every request in a chat shares",
      params: Type.Object({
        ...refParams,
        libraryId: Type.Optional(
          uuidParam(
            "The library to request into; the one the title is in, for its missing seasons",
          ),
        ),
      }),
      run: (params, signal) =>
        catalogDetails(
          account,
          {
            kind: params.kind,
            provider: params.provider,
            providerId: params.providerId,
          },
          params.libraryId,
          signal,
        ).pipe(Effect.map(compactCatalogDetail)),
    }),
  }
}
