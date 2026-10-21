import { Effect } from "effect"

import type { ServiceConfig } from "../../config.ts"
import type { JsonValue, Signal } from "../../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
} from "../../json.ts"
import { toolFail, type ToolFailure } from "../../tools/errors.ts"
import { MAX_OUTCOME_PART_CHARS } from "../../tools/results.ts"
import { itemKey, jellyfinRequest } from "./client.ts"
import {
  clip,
  itemLabel,
  MAX_FIELD_CHARS,
  MAX_NAME_CHARS,
  parseProviderIds,
  providerIdsOf,
} from "./compact.ts"
import { mediaItem, WHOLE_MEDIA } from "./media.ts"

const MAX_OVERVIEW_CHARS = 300

/**
 * A write's read-back is cut at `MAX_OUTCOME_PART_CHARS`. The item it shows
 * stays under that with room for the verdict next to it.
 */
const READ_BACK_ITEM_CHARS = MAX_OUTCOME_PART_CHARS - 2_000

/** The item types Jellyfin has a remote search for that this server offers. */
export const REMATCH_TYPES = ["Movie", "Series", "BoxSet", "Trailer"] as const

type RematchType = (typeof REMATCH_TYPES)[number]

export interface SearchSeed {
  name?: string | undefined
  year?: number | undefined
  provider?: string | undefined
  providerId?: string | undefined
}

/** What an Apply consumes of a candidate, validated. */
interface Candidate {
  Name: string | undefined
  ProductionYear: number | undefined
  SearchProviderName: string | undefined
  ProviderIds: Record<string, string>
}

export function rematchType(
  item: JsonObject,
): Effect.Effect<RematchType, ToolFailure> {
  const type = REMATCH_TYPES.find((entry) => entry === item.Type)
  return type
    ? Effect.succeed(type)
    : toolFail(
        `${itemLabel(item)} has no remote search of its own: Jellyfin matches ${REMATCH_TYPES.join(", ")}. For a season or episode, match its series`,
      )
}

/**
 * Asks the item's metadata providers for candidates. The request is built
 * here from named inputs. It changes nothing in Jellyfin.
 */
export function remoteSearch(
  cfg: ServiceConfig,
  type: RematchType,
  seed: SearchSeed,
  itemId: string | undefined,
  signal: Signal,
  timeoutMs: number,
): Effect.Effect<JsonValue[], ToolFailure> {
  return jellyfinRequest(cfg, `/Items/RemoteSearch/${type}`, {
    method: "POST",
    body: {
      SearchInfo: {
        ...(seed.name !== undefined ? { Name: seed.name } : {}),
        ...(seed.year !== undefined ? { Year: seed.year } : {}),
        ...(seed.provider !== undefined && seed.providerId !== undefined
          ? { ProviderIds: { [seed.provider]: seed.providerId } }
          : {}),
      },
      ...(itemId !== undefined ? { ItemId: itemKey(itemId) } : {}),
    },
    timeoutMs,
    signal,
  }).pipe(
    Effect.flatMap((response) =>
      Array.isArray(response)
        ? Effect.succeed(response)
        : toolFail("jellyfin returned no candidate list"),
    ),
  )
}

/** The fields an Apply consumes, or `undefined` when any of them is malformed. */
function candidateOf(entry: JsonValue): Candidate | undefined {
  if (!isJsonObject(entry)) return undefined
  const name = entry.Name ?? undefined
  const year = entry.ProductionYear ?? undefined
  const source = entry.SearchProviderName ?? undefined
  const ids = parseProviderIds(entry.ProviderIds)
  if (
    (name !== undefined && !isShortString(name)) ||
    (year !== undefined && !Number.isInteger(year)) ||
    (source !== undefined && !isShortString(source)) ||
    ids === undefined ||
    ids === "malformed" ||
    Object.keys(ids).length === 0
  ) {
    return undefined
  }
  return {
    Name: isString(name) ? name : undefined,
    ProductionYear: isNumber(year) ? year : undefined,
    SearchProviderName: isString(source) ? source : undefined,
    ProviderIds: ids,
  }
}

function isShortString(value: JsonValue): boolean {
  return isString(value) && value.length <= MAX_FIELD_CHARS
}

function providerIdOf(
  ids: Record<string, string>,
  provider: string,
): string | undefined {
  // Jellyfin compares provider names without regard to case.
  const key = Object.keys(ids).find(
    (name) => name.toLowerCase() === provider.toLowerCase(),
  )
  return key === undefined ? undefined : ids[key]
}

function candidateLabel(candidate: Candidate): string {
  return `${candidate.Name ?? "unnamed"} (${String(candidate.ProductionYear ?? "unknown year")}) from ${candidate.SearchProviderName ?? "an unnamed search provider"} with provider ids ${JSON.stringify(candidate.ProviderIds)}`
}

/** One candidate as a search lists it. Nothing of it is passed through whole. */
export function compactCandidate(entry: JsonValue): JsonObject {
  const candidate = candidateOf(entry)
  const raw = isJsonObject(entry) ? entry : undefined
  return {
    Name: clip(raw?.Name, MAX_NAME_CHARS),
    ProductionYear: clip(raw?.ProductionYear, 40),
    PremiereDate: clip(raw?.PremiereDate, 40),
    SearchProviderName: clip(raw?.SearchProviderName, MAX_NAME_CHARS),
    ProviderIds: candidate?.ProviderIds ?? null,
    Overview: clip(raw?.Overview, MAX_OVERVIEW_CHARS),
    ...(candidate ? {} : { malformed: true }),
  }
}

/**
 * The one live candidate carrying a provider id, as the request an Apply
 * sends. No candidate, an unreadable one, or several that differ fail here,
 * before anything is written.
 */
export function exactCandidate(
  found: readonly JsonValue[],
  wanted: {
    provider: string
    providerId: string
    searchProviderName?: string | undefined
  },
): Candidate {
  const identity = `${wanted.provider} ${wanted.providerId}`
  const candidates = found.map(candidateOf)
  const unreadable = candidates.filter((entry) => entry === undefined).length
  if (unreadable > 0) {
    throw new Error(
      `${unreadable} of ${found.length} candidates came back in a shape that cannot be checked, so the match for ${identity} is not established; nothing was written`,
    )
  }
  const carrying = candidates.flatMap((entry) =>
    entry &&
    providerIdOf(entry.ProviderIds, wanted.provider) === wanted.providerId
      ? [entry]
      : [],
  )
  const matching = carrying.filter(
    (entry) =>
      wanted.searchProviderName === undefined ||
      entry.SearchProviderName === wanted.searchProviderName,
  )
  // Two providers can return the same title; identical requests are one.
  const distinct = [
    ...new Map(matching.map((entry) => [canonical(entry), entry])).values(),
  ]
  const only = distinct[0]
  if (only !== undefined && distinct.length === 1) return only
  if (distinct.length > 1) {
    throw new Error(
      `${distinct.length} different candidates carry ${identity}: ${distinct.map(candidateLabel).join(" | ")}. Nothing was written. ${
        wanted.searchProviderName === undefined
          ? "Pass the searchProviderName of the one to apply"
          : "They share that search provider, so this tool cannot choose between them"
      }`,
    )
  }
  throw new Error(
    carrying.length > 0
      ? `no candidate with ${identity} comes from search provider ${String(wanted.searchProviderName)}; it is offered by ${carrying.map((entry) => entry.SearchProviderName ?? "an unnamed provider").join(", ")}. Nothing was written`
      : `no metadata provider returned a candidate with ${identity} just now (${found.length} other candidates). Nothing was written; read jellyfin_remote_search with that provider and providerId`,
  )
}

function canonical(candidate: Candidate): string {
  return JSON.stringify([
    candidate.Name,
    candidate.ProductionYear,
    candidate.SearchProviderName,
    Object.entries(candidate.ProviderIds).toSorted(([a], [b]) =>
      a.localeCompare(b),
    ),
  ])
}

/** Whether the item reads back with every provider id the rematch applied. */
export function rematchReadBack(
  item: JsonObject,
  expected: Record<string, string>,
): JsonValue {
  const actual = providerIdsOf(item, `item ${String(item.Id)}`) ?? {}
  const differing = Object.entries(expected).flatMap(([provider, id]) =>
    providerIdOf(actual, provider) === id ? [] : [provider],
  )
  return differing.length === 0
    ? {
        confirmed: "the applied provider ids read back",
        item: readBackItem(item),
      }
    : {
        warning: `read-back differs from the applied provider ids in ${differing.join(", ")}`,
        item: readBackItem(item),
      }
}

/** The item a write reads back, with as much of its media as that holds. */
export function readBackItem(item: JsonObject): JsonObject {
  return mediaItem(
    item,
    WHOLE_MEDIA,
    (listed) => JSON.stringify(listed).length <= READ_BACK_ITEM_CHARS,
  )
}
