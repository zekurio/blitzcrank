import { Effect } from "effect"
import { Type } from "typebox"

import type { Signal } from "../../http.ts"
import {
  isJsonObject,
  isString,
  objectField,
  objectList,
  pick,
  type JsonObject,
} from "../../json.ts"
import { toolFail, type ToolFailure } from "../../tools/errors.ts"
import { action, type WriteEffect } from "../../tools/writes.ts"
import { arrList, type Arr } from "./client.ts"
import { postCommand, verifyCommand } from "./commands.ts"

/**
 * A manual-import scan probes every file below the folder. Kept under the
 * time a write has to resolve its target, so the scan's own timeout reports
 * first.
 */
const MANUAL_IMPORT_TIMEOUT_MS = 40_000

/** The scope a manual-import scan is read with. */
export const manualImportScope = () => ({
  folder: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Folder as the Arr sees it, e.g. a queue item's outputPath",
    }),
  ),
  downloadId: Type.Optional(
    Type.String({ minLength: 1, description: "A queue item's downloadId" }),
  ),
})

export function readCandidates(
  arr: Arr,
  scope: { folder?: string | undefined; downloadId?: string | undefined },
  signal: Signal,
): Effect.Effect<JsonObject[], ToolFailure> {
  if (scope.folder === undefined && scope.downloadId === undefined) {
    return toolFail("pass folder, downloadId, or both")
  }
  return arrList(arr, "/api/v3/manualimport", {
    query: {
      folder: scope.folder,
      downloadId: scope.downloadId,
      filterExistingFiles: false,
    },
    timeoutMs: MANUAL_IMPORT_TIMEOUT_MS,
    signal,
  })
}

export function compactCandidate(candidate: JsonObject): JsonObject {
  const series = objectField(candidate, "series")
  const movie = objectField(candidate, "movie")
  return {
    ...pick(candidate, [
      "path",
      "folderName",
      "size",
      "quality",
      "languages",
      "releaseGroup",
      "downloadId",
      "seasonNumber",
      "customFormatScore",
    ]),
    ...(series ? { series: pick(series, ["id", "title", "tvdbId"]) } : {}),
    ...(movie ? { movie: pick(movie, ["id", "title", "year", "tmdbId"]) } : {}),
    ...(Array.isArray(candidate.episodes)
      ? {
          episodes: objectList(candidate.episodes).map((episode) =>
            pick(episode, ["id", "seasonNumber", "episodeNumber", "title"]),
          ),
        }
      : {}),
    rejections: rejectionReasons(candidate) ?? null,
  }
}

/**
 * Why the Arr would not import a candidate, or `undefined` when it sent no
 * list of reasons that can be read. An empty list is the only answer that
 * means it rejects nothing.
 */
function rejectionReasons(candidate: JsonObject): string[] | undefined {
  const rejections = candidate.rejections
  if (!Array.isArray(rejections)) return undefined
  const reasons = rejections.flatMap((rejection) =>
    isJsonObject(rejection) && isString(rejection.reason)
      ? [rejection.reason]
      : [],
  )
  return reasons.length === rejections.length ? reasons : undefined
}

/**
 * Fails an import whose candidates carry no readable rejection list. Those
 * would otherwise go out looking as if the Arr accepted them.
 */
function requireKnownRejections(
  arr: Arr,
  matches: CandidateMatch[],
): Effect.Effect<CandidateMatch[], ToolFailure> {
  const unknown = matches.filter(
    (match) => rejectionReasons(match.candidate) === undefined,
  )
  return unknown.length === 0
    ? Effect.succeed(matches)
    : toolFail(
        `${arr.service} sent no readable rejection list for ${unknown.map((match) => match.path).join(", ")}; whether it rejects them is unknown, so nothing was written`,
      )
}

interface CandidateMatch {
  path: string
  candidate: JsonObject
}

const MAX_IMPORT_FOLDERS = 3

/** The folder part of a path, whichever separator the Arr's host uses. */
function parentFolder(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "") || path
}

/**
 * Reads the candidates a manual import names and matches each submitted file
 * by path. A path the Arr does not offer fails the import: it would hand the
 * Arr a file it never inspected.
 */
export function matchCandidates(
  arr: Arr,
  scope: { folder?: string | undefined; downloadId?: string | undefined },
  paths: readonly string[],
  signal: Signal,
): Effect.Effect<CandidateMatch[], ToolFailure> {
  return Effect.gen(function* () {
    if (new Set(paths).size !== paths.length) {
      return yield* toolFail("a file path is named twice")
    }
    // Without a scope, each file's own folder is scanned: that scan always
    // lists the file itself.
    const scopes =
      scope.folder !== undefined || scope.downloadId !== undefined
        ? [scope]
        : [...new Set(paths.map(parentFolder))].map((folder) => ({ folder }))
    if (scopes.length > MAX_IMPORT_FOLDERS) {
      return yield* toolFail(
        `the files lie in ${scopes.length} folders; pass folder or downloadId, or import them in smaller calls`,
      )
    }
    const scans = yield* Effect.forEach(
      scopes,
      (entry) => readCandidates(arr, entry, signal),
      { concurrency: MAX_IMPORT_FOLDERS },
    )
    const candidates = scans.flat()
    const missing = paths.filter(
      (path) => !candidates.some((candidate) => candidate.path === path),
    )
    if (missing.length > 0) {
      return yield* toolFail(
        `not among ${arr.service}'s current manual-import candidates: ${missing.join(", ")}`,
      )
    }
    return yield* requireKnownRejections(
      arr,
      paths.flatMap((path) => {
        const candidate = candidates.find((entry) => entry.path === path)
        return candidate ? [{ path, candidate }] : []
      }),
    )
  })
}

/**
 * What a manual import sends for one file besides its target. Taken from the
 * live candidate, so the Arr gets back exactly what it reported.
 */
export function candidateFile(
  match: CandidateMatch,
  downloadId: string | undefined,
): JsonObject {
  return {
    ...pick(match.candidate, [
      "folderName",
      "quality",
      "languages",
      "releaseGroup",
    ]),
    path: match.path,
    downloadId: match.candidate.downloadId ?? downloadId,
  }
}

/**
 * What a downloaded-files scan of `path` would consider. Fails when the Arr
 * sees nothing importable there, which is also how a wrong path shows up.
 */
function scanCandidates(
  arr: Arr,
  path: string,
  signal: Signal,
): Effect.Effect<CandidateMatch[], ToolFailure> {
  return arrList(arr, "/api/v3/manualimport", {
    query: { folder: path, filterExistingFiles: true },
    timeoutMs: MANUAL_IMPORT_TIMEOUT_MS,
    signal,
  }).pipe(
    Effect.flatMap((candidates) => {
      const matches = candidates.flatMap((candidate) =>
        isString(candidate.path) ? [{ path: candidate.path, candidate }] : [],
      )
      // The scan imports every candidate, so one that cannot be named is one
      // the write could not show.
      if (matches.length < candidates.length) {
        return toolFail(
          `${arr.service} listed ${candidates.length - matches.length} of ${candidates.length} candidates under ${path} without a path, so what the scan would import is unknown; nothing was written`,
        )
      }
      return matches.length > 0
        ? requireKnownRejections(arr, matches)
        : toolFail(`${arr.service} sees no importable file under ${path}`)
    }),
  )
}

export function candidateWarnings(matches: CandidateMatch[]): string[] {
  return matches.flatMap((match) =>
    (rejectionReasons(match.candidate) ?? []).map(
      (reason) => `${match.path}: ${reason}`,
    ),
  )
}

/**
 * The write that scans one folder and imports what the Arr accepts from it.
 * `mapping` says where the Arr would put one candidate.
 */
export function folderScanAction(
  arr: Arr,
  mapping: (candidate: JsonObject) => string,
) {
  return action({
    description:
      `Scan one folder and import every file in it the Arr accepts into the library (${arr.scanCommand}). ` +
      "Accepted files are moved or copied out of the folder as the Arr decides; rejected files stay where they are",
    params: Type.Object({
      path: Type.String({
        minLength: 1,
        description: "Folder to scan and import, as the Arr sees it",
      }),
    }),
    resolve: (params, signal) =>
      scanCandidates(arr, params.path, signal).pipe(
        Effect.map((matches) => ({
          state: null,
          summary: `Scan ${params.path} and import what ${arr.service} accepts: ${matches.length} candidate file(s)`,
          effects: matches.map(
            (match): WriteEffect => ({
              kind: "import",
              target: match.path,
              detail: `mapped to ${mapping(match.candidate)}`,
            }),
          ),
          warnings: candidateWarnings(matches),
        })),
      ),
    write: (params) =>
      postCommand(arr, { name: arr.scanCommand, path: params.path }),
    verify: (_params, result) => verifyCommand(arr, result),
  })
}
