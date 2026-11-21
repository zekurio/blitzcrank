import { Effect } from "effect"
import { Type } from "typebox"

import type { JsonValue } from "../../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  objectField,
  objectList,
  type JsonObject,
} from "../../json.ts"
import { toolCheck, toolFail, type ToolFailure } from "../../tools/errors.ts"
import { action, type WriteEffect } from "../../tools/writes.ts"
import { planAsk } from "./ask.ts"
import {
  catalogDetails,
  matineeRequest,
  readLibrary,
  readTitle,
  refParams,
  segment,
  uuidParam,
  type MatineeAccount,
} from "./client.ts"
import {
  compactAdminRequest,
  compactAvailability,
  compactCatalogDetail,
  compactLibrary,
  compactMatch,
  compactRequestItem,
  titleLabel,
  titleMatch,
} from "./compact.ts"
import { folderTagWarnings } from "./folder-ids.ts"
import { readMatches } from "./reads.ts"
import { findRequest, requestLabel } from "./requests.ts"

/**
 * A refresh or a new match answers once Matinee has fetched the title's
 * metadata, which waits for a free metadata job. The write phase gives a
 * call 90 s, so the request's own timeout reports first.
 */
const METADATA_TIMEOUT_MS = 85_000

const titleIdParam = uuidParam("A Matinee title id, from matinee_search")

/** The title and its library, and the library's metadata provider. */
function readTitleAndProvider(
  admin: MatineeAccount,
  titleId: string,
  signal: AbortSignal | undefined,
) {
  return Effect.gen(function* () {
    const title = yield* readTitle(admin, titleId, signal)
    const library = yield* readLibrary(admin, String(title.libraryId), signal)
    const provider = library.metadataProvider
    if (!isString(provider)) {
      return yield* toolFail(
        `the library ${String(library.name)} has no metadata provider, so Matinee neither refreshes nor matches its titles. Nothing was written`,
      )
    }
    return { title, library, provider }
  })
}

function matchOf(title: JsonObject): string {
  return `${String(title.provider ?? "no provider")} ${String(title.providerId ?? "unmatched")}`
}

function titleEffect(
  kind: string,
  title: JsonObject,
  library: JsonObject,
  detail: string,
): WriteEffect {
  return {
    kind,
    target: `${titleLabel(title)} (${String(title.id)})`,
    detail: [
      `library ${String(library.name)}`,
      `path ${String(title.path ?? "unknown")}`,
      detail,
    ].join("; "),
  }
}

function readBackTitle(
  admin: MatineeAccount,
  titleId: string,
  expected: (title: JsonObject) => boolean,
  confirmed: string,
): Effect.Effect<JsonValue, ToolFailure> {
  return readTitle(admin, titleId, undefined).pipe(
    Effect.map(
      (title): JsonValue =>
        expected(title)
          ? { confirmed, title: titleMatch(title) }
          : {
              warning:
                "the title does not show the expected match; read it again",
              title: titleMatch(title),
            },
    ),
  )
}

export function matineeActions(admin: MatineeAccount) {
  return {
    scan_library: action({
      // The same full scan of one library that the timed scan runs.
      destructive: false,
      description:
        "Queue a scan of one library's folders, as the timed scan does: new and changed files are read and files gone from disk leave the library. " +
        "It returns once the scan is queued, before any file is found",
      params: Type.Object({
        libraryId: uuidParam("A library id, from matinee_libraries"),
      }),
      lock: (params) => `library:${params.libraryId}`,
      resolve: (params, signal) =>
        readLibrary(admin, params.libraryId, signal).pipe(
          Effect.map((library) => {
            const shown = compactLibrary(library)
            return {
              state: null,
              summary: `Scan library ${String(library.name)}`,
              effects: [
                {
                  kind: "scan",
                  target: `library ${String(library.name)} (${params.libraryId})`,
                  detail: [
                    `folders ${JSON.stringify(shown.folders)}`,
                    `last scanned ${String(library.lastScannedAt ?? "never")}`,
                    library.scanning === true ? "a scan is running now" : "",
                  ]
                    .filter((part) => part !== "")
                    .join("; "),
                },
              ],
              warnings: [
                "a scan only queues work: read the title or the library's files afterwards to see what it found",
              ],
            }
          }),
        ),
      write: (params) =>
        matineeRequest(admin, `/libraries/${segment(params.libraryId)}/scan`, {
          method: "POST",
          body: {},
        }).pipe(
          Effect.map((): JsonValue => ({ queued: "Matinee queued the scan" })),
        ),
      verify: (params) =>
        readLibrary(admin, params.libraryId, undefined).pipe(
          Effect.map(
            (library): JsonValue => ({
              queued: true,
              scanning: library.scanning ?? null,
              lastScannedAt: library.lastScannedAt ?? null,
              note: "the scan is queued or running; this shows no file arrived. Read the title or matinee_files once it is done, and matinee_jobs for its probe",
            }),
          ),
        ),
    }),
    refresh_title: action({
      description:
        "Fetch one title's metadata again now from its library's provider, replacing its details, seasons, episodes, and credits. " +
        "A provider id in the folder name wins over the stored match, and a title with no match is searched by name; the preview warns of both",
      params: Type.Object({ titleId: titleIdParam }),
      lock: (params) => `title:${params.titleId}`,
      resolve: (params, signal) =>
        readTitleAndProvider(admin, params.titleId, signal).pipe(
          Effect.map(({ title, library, provider }) => {
            const matched =
              title.provider === provider && isString(title.providerId)
            return {
              state: {
                before: matchOf(title),
                refreshedAt: title.refreshedAt ?? null,
              },
              summary: `Refresh ${titleLabel(title)} from ${provider}`,
              effects: [
                titleEffect(
                  "refresh",
                  title,
                  library,
                  `match ${matchOf(title)}`,
                ),
              ],
              warnings: [
                "the title's details, seasons, episodes, and credits are replaced by what the provider has now",
                ...(matched
                  ? folderTagWarnings(
                      title,
                      provider,
                      String(title.providerId),
                      "now",
                    )
                  : [
                      `the title has no ${provider} match, so Matinee searches by name; when nothing matches, it resets the title to its folder name and drops its metadata and the images an admin chose from the provider`,
                    ]),
              ],
            }
          }),
        ),
      write: (params) =>
        matineeRequest(admin, `/titles/${segment(params.titleId)}/refresh`, {
          method: "POST",
          body: {},
          timeoutMs: METADATA_TIMEOUT_MS,
        }).pipe(
          Effect.map(
            (title): JsonValue =>
              isJsonObject(title) ? { refreshed: titleMatch(title) } : null,
          ),
        ),
      verify: (params, _result, state) =>
        readBackTitle(
          admin,
          params.titleId,
          (title) =>
            isString(title.refreshedAt) &&
            title.refreshedAt !== state.refreshedAt,
          `refreshed; the match was ${state.before}`,
        ),
    }),
    identify_title: action({
      description:
        "Match one title to another candidate at its library's provider and fetch its metadata, to fix a wrong or missing match. " +
        "The candidate must be one matinee_matches lists for the same query and year; the title's metadata, seasons, episodes, and credits are replaced",
      params: Type.Object({
        titleId: titleIdParam,
        providerId: Type.String({
          minLength: 1,
          maxLength: 64,
          description: "The candidate's id, from matinee_matches",
        }),
        query: Type.String({
          minLength: 1,
          maxLength: 200,
          description: "The query matinee_matches listed the candidate for",
        }),
        year: Type.Optional(Type.Integer({ minimum: 1870, maximum: 2200 })),
      }),
      lock: (params) => `title:${params.titleId}`,
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const found = yield* readTitleAndProvider(
            admin,
            params.titleId,
            signal,
          )
          const title = found.title
          const provider = found.provider
          const matches = yield* readMatches(admin, params, signal)
          const candidate = matches.find(
            (match) =>
              match.id === params.providerId && match.provider === provider,
          )
          if (!candidate) {
            return yield* toolFail(
              `Matinee's ${provider} search for "${params.query}" lists no candidate ${params.providerId}; nothing was written. Read matinee_matches with a query that lists it`,
            )
          }
          if (
            title.provider === provider &&
            title.providerId === params.providerId
          ) {
            return yield* toolFail(
              `${titleLabel(title)} is matched to ${provider} ${params.providerId} already; nothing was written`,
            )
          }
          const shown = compactMatch(candidate)
          return {
            state: null,
            summary: `Match ${titleLabel(title)} to ${String(shown.name)} (${String(shown.year ?? "unknown year")})`,
            effects: [
              titleEffect(
                "rematch",
                title,
                found.library,
                `from ${matchOf(title)}, ${titleLabel(title)}, to ${provider} ${params.providerId}, ${String(shown.name)} (${String(shown.year ?? "unknown year")})`,
              ),
            ],
            warnings: [
              "the title's details, seasons, episodes, and credits are replaced by the new match's",
              "images an admin chose from the provider are dropped; uploaded images stay",
              ...folderTagWarnings(title, provider, params.providerId, "later"),
            ],
          }
        }),
      write: (params) =>
        matineeRequest(admin, `/titles/${segment(params.titleId)}/identify`, {
          method: "POST",
          body: { providerId: params.providerId },
          timeoutMs: METADATA_TIMEOUT_MS,
        }).pipe(
          Effect.map(
            (title): JsonValue =>
              isJsonObject(title) ? { matched: titleMatch(title) } : null,
          ),
        ),
      verify: (params) =>
        readBackTitle(
          admin,
          params.titleId,
          (title) => title.providerId === params.providerId,
          `the title is matched to ${params.providerId}`,
        ),
    }),
    retry_request: action({
      description:
        "Send one approved request whose send failed to its connection again. Radarr or Sonarr then add or monitor the title and may search for it",
      params: Type.Object({
        requestId: uuidParam("The request's id, from matinee_requests"),
      }),
      lock: (params) => `request:${params.requestId}`,
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const search = yield* findRequest(admin, params.requestId, signal)
          const entry = search.entries[0]
          if (!entry) {
            return yield* toolFail(
              `the request queue has no request ${params.requestId}; nothing was written`,
            )
          }
          if (entry.list !== "needsAttention") {
            return yield* toolFail(
              `only an approved request whose send failed can be retried; ${params.requestId} is ${String(entry.item.status)} with send state ${String(entry.item.fulfilmentState ?? "none")}. Nothing was written`,
            )
          }
          const item = compactAdminRequest(entry.item)
          const connection = objectField(entry.item, "connection")
          return {
            state: null,
            summary: `Retry the request for ${requestLabel(entry.item)}`,
            effects: [
              {
                kind: "retry",
                target: `${requestLabel(entry.item)} (request ${params.requestId})`,
                detail: [
                  `library ${String(objectField(entry.item, "library")?.name ?? "unknown")}`,
                  connection
                    ? `connection ${String(connection.name)} (${String(connection.sourceName)})`
                    : "no connection fills the library now; Matinee resends it the way a new request would go",
                  `scope ${JSON.stringify(item.scope)}`,
                  `failed with: ${String(item.error ?? "no error recorded")}`,
                ].join("; "),
              },
            ],
            warnings: [
              "the download manager may set the title or its seasons monitored and search for them, which can grab and replace files",
            ],
          }
        }),
      write: (params) =>
        matineeRequest(admin, "/admin/requests/retry", {
          method: "POST",
          body: { id: params.requestId },
        }).pipe(
          Effect.map((): JsonValue => ({ queued: "Matinee queued the send" })),
        ),
      verify: (params) =>
        findRequest(admin, params.requestId, undefined).pipe(
          Effect.map((search): JsonValue => {
            const entry = search.entries[0]
            if (!entry) return { warning: "the request is gone from the queue" }
            return {
              ...(entry.list === "needsAttention"
                ? {
                    warning:
                      "the request still shows a failed send; read it again shortly",
                  }
                : { confirmed: "the request left the failed list" }),
              list: entry.list,
              request: compactAdminRequest(entry.item),
            }
          }),
        ),
    }),
  }
}

/**
 * The one write the request account makes. Matinee applies that account's
 * group: whether it may request, whether a request waits for approval, and
 * its quota.
 */
export function matineeRequestActions(requester: MatineeAccount) {
  return {
    ask: action({
      description:
        "Request a title the server lacks, or seasons of a show it has, through the request account, as Matinee's own request button does. " +
        "For a show, seasons names the seasons to add and future adds the ones still to come; without seasons Matinee's default asks for every aired season and the ones to come. " +
        "libraryId picks the library, such as the one a show is in for its missing seasons",
      params: Type.Object({
        ...refParams,
        libraryId: Type.Optional(
          uuidParam(
            "The library to request into, from matinee_catalog_details",
          ),
        ),
        seasons: Type.Optional(
          Type.Array(Type.Integer({ minimum: 0 }), {
            minItems: 1,
            maxItems: 100,
          }),
        ),
        future: Type.Optional(
          Type.Boolean({ description: "Also ask for seasons as they air" }),
        ),
      }),
      lock: (params) =>
        `ask:${params.kind}:${params.provider}:${params.providerId}`,
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const ref = {
            kind: params.kind,
            provider: params.provider,
            providerId: params.providerId,
          }
          const detail = yield* catalogDetails(
            requester,
            ref,
            params.libraryId,
            signal,
          )
          return yield* toolCheck(() =>
            planAsk(detail, {
              ref,
              seasons: params.seasons,
              future: params.future,
            }),
          )
        }),
      write: (_params, state) =>
        matineeRequest(requester, "/requests/ask", {
          method: "POST",
          body: {
            ref: {
              kind: state.ref.kind,
              provider: state.ref.provider,
              providerId: state.ref.providerId,
            },
            libraryId: state.libraryId,
            ...(state.scope !== undefined
              ? {
                  scope: {
                    seasons: state.scope.seasons,
                    future: state.scope.future,
                  },
                }
              : {}),
          },
          timeoutMs: 60_000,
        }).pipe(
          Effect.map(
            (item): JsonValue =>
              isJsonObject(item) ? { request: compactRequestItem(item) } : null,
          ),
        ),
      verify: (_params, _result, state) =>
        catalogDetails(requester, state.ref, state.libraryId, undefined).pipe(
          Effect.map((detail): JsonValue => {
            const availability = compactAvailability(
              objectField(detail, "availability"),
            )
            const seasons = state.scope?.seasons ?? []
            return {
              ...(isString(availability?.requestId)
                ? { confirmed: "Matinee has a request for the title" }
                : {
                    warning:
                      "Matinee shows no request for the title; read it again",
                  }),
              availability,
              ...(seasons.length > 0
                ? {
                    seasons: objectList(
                      compactCatalogDetail(detail).seasons,
                    ).filter(
                      (season) =>
                        isNumber(season.number) &&
                        seasons.includes(season.number),
                    ),
                  }
                : {}),
            }
          }),
        ),
    }),
  }
}
