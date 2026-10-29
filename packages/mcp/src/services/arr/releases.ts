import { Effect } from "effect"
import { Type } from "typebox"

import type { JsonValue, Signal } from "../../http.ts"
import {
  isNumber,
  isString,
  names,
  stringList,
  type JsonObject,
} from "../../json.ts"
import {
  failureMessage,
  toolCheck,
  type ToolFailure,
} from "../../tools/errors.ts"
import { keptRead } from "../../tools/kept-reads.ts"
import { fittingCount } from "../../tools/results.ts"
import { arrList, type Arr } from "./client.ts"
import { qualityName } from "./compact.ts"
import { MAX_MESSAGE_CHARS, readHealth } from "./diagnostics.ts"

/** Release searches wait on every indexer; the default 30s is too short. */
const RELEASE_TIMEOUT_MS = 120_000
/**
 * How long one release search answers later reads of the same target. Well
 * under the half hour the Arr keeps the search itself, so a release listed
 * from a kept search can still be grabbed.
 */
export const RELEASE_REUSE_MINUTES = 10

/** Short enough that a search near its own timeout still answers in time. */
const HEALTH_TIMEOUT_MS = 15_000

const DEFAULT_RELEASE_LIMIT = 20
const MAX_REJECTION_GROUPS = 8
const MAX_HEALTH_WARNINGS = 8

/**
 * The health checks that change what a search lists: indexers in backoff for
 * under or over six hours, no indexer enabled or available for search, and a
 * Jackett `/all` indexer, which the Arr disables whole when one of its
 * trackers fails. `IndexerRssCheck` is about RSS sync and
 * `IndexerDownloadClientCheck` about grabs, so neither empties a search.
 */
const SEARCH_HEALTH_CHECKS: ReadonlySet<string> = new Set([
  "IndexerStatusCheck",
  "IndexerLongTermStatusCheck",
  "IndexerSearchCheck",
  "IndexerJackettAllCheck",
])

export interface ReleaseFilters {
  publishedAfter?: string | undefined
  titleContains?: string | undefined
  approvedOnly?: boolean | undefined
  limit?: number | undefined
}

export interface ReleaseTarget {
  path: string
  /** Whether the Arr mapped this release to the requested item. */
  matches: (release: JsonObject) => boolean
  /** Service-specific mapping fields for one listed release. */
  describe?: (release: JsonObject) => JsonObject
}

export const releaseFilterParams = () => ({
  publishedAfter: Type.Optional(
    Type.String({
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Only releases published on or after this UTC date",
    }),
  ),
  titleContains: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Only releases whose title contains this text",
    }),
  ),
  approvedOnly: Type.Optional(
    Type.Boolean({ description: "Only releases the Arr would grab" }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: `How many releases to list (default ${DEFAULT_RELEASE_LIMIT})`,
    }),
  ),
})

/**
 * Runs one release search and returns counts over every hit plus a filtered,
 * capped listing in the Arr's own preference order. A raw release search
 * returns every indexer hit in full, so the result cap left only the first few
 * candidates, which once read as "no replacement exists". Releases the Arr
 * mapped to another item are only counted: an episode search also returns
 * other episodes' releases, which buried the requested ones.
 *
 * The search asks every indexer, so its raw hits are kept and later reads of
 * the same target are filtered from that copy. Approvals in a kept search are
 * as old as `searchAgeSeconds` says.
 *
 * A search with no release for the target looks the same whether nothing was
 * published or no indexer answered, so that result carries the Arr's indexer
 * health checks as warnings.
 */
export function readReleases(
  arr: Arr,
  target: ReleaseTarget,
  filters: ReleaseFilters,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return Effect.gen(function* () {
    const search = yield* keptRead(
      `${arr.service} ${target.path}`,
      RELEASE_REUSE_MINUTES * 60_000,
      arrList(arr, target.path, { timeoutMs: RELEASE_TIMEOUT_MS, signal }),
    )
    const releases = search.items
    const forTarget = releases.filter(target.matches)
    const elsewhere = releases.filter((release) => !target.matches(release))
    const matching = forTarget.filter((release) =>
      matchesFilters(release, filters),
    )
    const listed = matching
      .slice(0, filters.limit ?? DEFAULT_RELEASE_LIMIT)
      .map((release) => ({
        ...compactRelease(release),
        ...target.describe?.(release),
      }))
    const warnings =
      forTarget.length === 0 ? yield* indexerWarnings(arr, signal) : []
    const summary: JsonObject = {
      searchAgeSeconds: Math.round(search.ageMs / 1000),
      total: releases.length,
      forTarget: forTarget.length,
      approvedForTarget: forTarget.filter(
        (release) => release.approved === true,
      ).length,
      matchingFilters: matching.length,
      rejectionsInMatching: rejectionGroups(matching),
      otherTargets: {
        count: elsewhere.length,
        examples: elsewhere.slice(0, 5).map((release) => release.title ?? null),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    }
    return yield* toolCheck(() => fitListing(summary, listed))
  })
}

/**
 * The Arr's indexer health checks, read fresh on every call: health kept with
 * the search would hide an outage or a recovery. A health read that fails
 * still answers, since the release read itself succeeded.
 */
function indexerWarnings(arr: Arr, signal: Signal): Effect.Effect<string[]> {
  const unproven = "this list proves nothing about what was published"
  return readHealth(arr, { signal, timeoutMs: HEALTH_TIMEOUT_MS }).pipe(
    Effect.map((checks) => {
      const problems = checks
        .filter(
          (check) =>
            isString(check.source) && SEARCH_HEALTH_CHECKS.has(check.source),
        )
        .slice(0, MAX_HEALTH_WARNINGS)
        .map((check) => `${check.source} ${check.type}: ${check.message}`)
      return problems.length === 0
        ? []
        : [
            `${arr.service} reports indexer problems, so ${unproven}`,
            ...problems,
          ]
    }),
    Effect.catch((error) =>
      Effect.succeed([
        `${arr.service} indexer health could not be read, so ${unproven}: ${failureMessage(error).slice(0, MAX_MESSAGE_CHARS)}`,
      ]),
    ),
  )
}

/**
 * Drops trailing entries until the result fits one tool result. A cut listing
 * would be invalid JSON and lose the entries' closing fields.
 */
function fitListing(summary: JsonObject, listed: JsonObject[]): JsonObject {
  const withCount = (count: number): JsonObject => ({
    ...summary,
    listed: count,
    releases: listed.slice(0, count),
  })
  return withCount(
    fittingCount(listed.length, withCount, {
      entry: "the first matching release",
    }),
  )
}

function matchesFilters(release: JsonObject, filters: ReleaseFilters): boolean {
  if (filters.approvedOnly === true && release.approved !== true) return false
  if (
    filters.publishedAfter !== undefined &&
    !(
      isString(release.publishDate) &&
      release.publishDate.slice(0, 10) >= filters.publishedAfter
    )
  ) {
    return false
  }
  if (filters.titleContains === undefined) return true
  return (
    isString(release.title) &&
    release.title.toLowerCase().includes(filters.titleContains.toLowerCase())
  )
}

/** `guid` and `indexerId` are what a release is grabbed by. */
export function compactRelease(release: JsonObject): JsonObject {
  const rejections = stringList(release.rejections)
  return {
    title: release.title ?? null,
    guid: release.guid ?? null,
    indexerId: release.indexerId ?? null,
    published: isString(release.publishDate)
      ? release.publishDate.slice(0, 10)
      : null,
    indexer: release.indexer ?? null,
    protocol: release.protocol ?? null,
    sizeMb: isNumber(release.size)
      ? Math.round(release.size / 1_000_000)
      : null,
    quality: qualityName(release.quality),
    languages: names(release.languages),
    customFormatScore: release.customFormatScore ?? null,
    customFormats: names(release.customFormats),
    approved: release.approved === true,
    ...(rejections.length > 0 ? { rejections } : {}),
  }
}

function rejectionGroups(releases: JsonObject[]): JsonValue[] {
  const counts = new Map<string, number>()
  for (const reason of releases.flatMap((release) =>
    stringList(release.rejections),
  )) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_REJECTION_GROUPS)
    .map(([reason, count]) => ({ reason, count }))
}
