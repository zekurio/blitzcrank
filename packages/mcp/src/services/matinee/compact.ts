import type { JsonValue } from "../../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  objectField,
  objectList,
  pick,
  stringList,
  type JsonObject,
} from "../../json.ts"

/*
 * Every Matinee result is cut down to an allowlist of fields. Artwork,
 * people, followers' names, decline notes, remote URLs, and the signed-in
 * account's own watch state never leave this module.
 */

const MAX_NAME_CHARS = 200
const MAX_TEXT_CHARS = 500
const MAX_TRACK_TITLE_CHARS = 80
const MAX_EXTERNAL_IDS = 12
const MAX_DIAGNOSTICS = 20

export function clip(value: JsonValue | undefined, max: number): JsonValue {
  if (isString(value)) {
    return value.length > max ? `${value.slice(0, max)}…` : value
  }
  return value ?? null
}

function externalIds(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => isString(entry[1]))
      .slice(0, MAX_EXTERNAL_IDS)
      .map(([site, id]) => [site, clip(id, 64)]),
  )
}

/** A movie or show as lists name it. */
export function compactTitleSummary(title: JsonObject): JsonObject {
  return {
    ...pick(title, ["id", "libraryId", "kind"]),
    name: clip(title.name, MAX_NAME_CHARS),
    year: title.year ?? null,
  }
}

/** What identifies a title's match, for comparing one before and after. */
export function titleMatch(title: JsonObject): JsonObject {
  return {
    ...compactTitleSummary(title),
    path: clip(title.path, MAX_TEXT_CHARS),
    provider: title.provider ?? null,
    providerId: title.providerId ?? null,
    externalIds: externalIds(title.externalIds),
    refreshedAt: title.refreshedAt ?? null,
  }
}

function season(entry: JsonObject): JsonObject {
  return {
    number: entry.number ?? null,
    name: clip(entry.name, MAX_NAME_CHARS),
    itemCount: entry.itemCount ?? null,
  }
}

export function compactTitle(title: JsonObject): JsonObject {
  const specials = objectField(title, "specials")
  return {
    ...titleMatch(title),
    originalName: clip(title.originalName, MAX_NAME_CHARS),
    releaseDate: title.releaseDate ?? null,
    status: title.status ?? null,
    itemCount: title.itemCount ?? null,
    seasons: objectList(title.seasons).map(season),
    ...(specials ? { specials: season(specials) } : {}),
  }
}

export function titleLabel(title: JsonObject): string {
  const year = isNumber(title.year) ? ` (${title.year})` : ""
  return `${String(title.name ?? "unnamed")}${year}`
}

function audioStream(stream: JsonObject): JsonObject {
  return {
    ...pick(stream, ["index", "language", "format", "layout", "channels"]),
    title: clip(stream.title, MAX_TRACK_TITLE_CHARS),
    default: stream.default ?? null,
  }
}

function subtitleStream(stream: JsonObject): JsonObject {
  return {
    ...pick(stream, [
      "index",
      "language",
      "codec",
      "kind",
      "forced",
      "hearingImpaired",
    ]),
    title: clip(stream.title, MAX_TRACK_TITLE_CHARS),
    default: stream.default ?? null,
  }
}

/**
 * One file of a title with what ffprobe read from it. A file not probed yet
 * lists no streams at all, rather than an empty list that would read as a
 * file without tracks.
 */
export function compactItem(item: JsonObject): JsonObject {
  const probe = objectField(item, "probe")
  const video = objectField(probe, "video")
  const label = objectField(item, "label")
  const episode = objectField(item, "episode")
  return {
    id: item.id ?? null,
    seasonNumber: item.seasonNumber ?? null,
    episodeNumber: item.episodeNumber ?? null,
    code: label?.code ?? null,
    episodeName: clip(episode?.name, MAX_NAME_CHARS),
    relativePath: clip(item.relativePath, MAX_TEXT_CHARS),
    ...pick(item, ["container", "sizeBytes", "modifiedAt", "durationSeconds"]),
    probed: probe !== undefined,
    ...(probe
      ? {
          video: video
            ? pick(video, [
                "format",
                "resolution",
                "width",
                "height",
                "bitDepth",
                "dynamicRange",
                "bitRate",
              ])
            : null,
          audio: objectList(probe.audio).map(audioStream),
          embeddedSubtitles: objectList(probe.subtitles).map(subtitleStream),
        }
      : {}),
  }
}

/** A file as a library's file list names it. */
export function compactFile(item: JsonObject): JsonObject {
  const title = objectField(item, "title")
  return {
    id: item.id ?? null,
    relativePath: clip(item.relativePath, MAX_TEXT_CHARS),
    title: title ? compactTitleSummary(title) : null,
    ...pick(item, ["seasonNumber", "episodeNumber", "sizeBytes", "modifiedAt"]),
    probed: objectField(item, "probe") !== undefined,
  }
}

export function compactAudioTrack(track: JsonObject): JsonObject {
  return {
    ...pick(track, [
      "index",
      "language",
      "format",
      "codec",
      "layout",
      "channels",
      "primary",
    ]),
    title: clip(track.title, MAX_TRACK_TITLE_CHARS),
  }
}

export function compactSubtitleTrack(track: JsonObject): JsonObject {
  return {
    ...pick(track, [
      "id",
      "language",
      "source",
      "format",
      "forced",
      "sdh",
      "default",
      "delivery",
    ]),
    title: clip(track.title, MAX_TRACK_TITLE_CHARS),
  }
}

export function compactLibrary(library: JsonObject): JsonObject {
  return {
    ...pick(library, ["id", "kind"]),
    name: clip(library.name, MAX_NAME_CHARS),
    folders: stringList(library.paths).map((path) =>
      clip(path, MAX_TEXT_CHARS),
    ),
    ...pick(library, [
      "itemCount",
      "titleCount",
      "metadataProvider",
      "metadataLanguage",
      "lastScannedAt",
      "scanning",
      "refreshing",
    ]),
  }
}

/**
 * Where a title stands for the account that asked, as Matinee works it out.
 * Who else asked is a count, never names, and a decline keeps its reason
 * code but not the admin's note.
 */
export function compactAvailability(
  availability: JsonObject | undefined,
): JsonObject | null {
  if (availability === undefined) return null
  const others = objectField(availability, "others")
  const reason = objectField(availability, "reason")
  return {
    ...pick(availability, [
      "state",
      "action",
      "disabledReason",
      "progress",
      "etaSeconds",
      "releaseDate",
      "stillLooking",
      "askedBySelf",
      "requestId",
      "libraryTitleId",
      "limit",
    ]),
    othersAsking: others?.count ?? 0,
    ...(reason ? { declined: pick(reason, ["kind", "code"]) } : {}),
  }
}

function seasonAvailability(entry: JsonObject | undefined): JsonObject | null {
  if (entry === undefined) return null
  return {
    number: entry.number ?? null,
    episodesHere: entry.episodesHere ?? null,
    episodesAired: entry.episodesAired ?? null,
    ...compactAvailability(entry),
  }
}

export function compactCatalogEntry(entry: JsonObject): JsonObject {
  return {
    ref: entry.ref ?? null,
    name: clip(entry.name, MAX_NAME_CHARS),
    year: entry.year ?? null,
    availability: compactAvailability(objectField(entry, "availability")),
  }
}

export function compactCatalogDetail(detail: JsonObject): JsonObject {
  return {
    ...compactCatalogEntry(detail),
    stale: detail.stale ?? null,
    overview: clip(detail.overview, 300),
    genres: stringList(detail.genres).slice(0, 10),
    seasons: objectList(detail.seasons).map((entry) => ({
      ...pick(entry, ["number", "episodeCount", "airDate", "selected"]),
      availability: seasonAvailability(objectField(entry, "availability")),
    })),
    defaultScope: detail.defaultScope ?? null,
    destinations: objectList(detail.destinations).map((destination) => ({
      ...pick(destination, ["id", "selected"]),
      name: clip(destination.name, MAX_NAME_CHARS),
    })),
  }
}

/** One request as the admin queue has it, without who asked. */
export function compactAdminRequest(item: JsonObject): JsonObject {
  const title = objectField(item, "title")
  const library = objectField(item, "library")
  const connection = objectField(item, "connection")
  return {
    id: item.id ?? null,
    ...pick(item, ["status", "fulfilmentState"]),
    error: clip(item.error, MAX_TEXT_CHARS),
    title: title
      ? {
          ref: title.ref ?? null,
          name: clip(title.name, MAX_NAME_CHARS),
          year: title.year ?? null,
        }
      : null,
    library: library
      ? { id: library.id ?? null, name: clip(library.name, MAX_NAME_CHARS) }
      : null,
    scope: item.scope ?? null,
    ...pick(item, ["createdAt", "arrivedAt", "declinedAt"]),
    declineReason: item.reason ?? null,
    connection: connection
      ? {
          name: clip(connection.name, MAX_NAME_CHARS),
          ...pick(connection, ["sourceName", "reportsProgress"]),
        }
      : null,
    availability: compactAvailability(objectField(item, "availability")),
    season: seasonAvailability(objectField(item, "season")),
    diagnostics: objectList(item.diagnostics)
      .slice(0, MAX_DIAGNOSTICS)
      .map((entry) => ({
        label: clip(entry.label, MAX_NAME_CHARS),
        value: clip(entry.value, MAX_TEXT_CHARS),
      })),
  }
}

/** A request as the account that made it gets it back from an ask. */
export function compactRequestItem(item: JsonObject): JsonObject {
  const library = objectField(item, "library")
  return {
    id: item.id ?? null,
    library: library
      ? { id: library.id ?? null, name: clip(library.name, MAX_NAME_CHARS) }
      : null,
    scope: item.scope ?? null,
    availability: compactAvailability(objectField(item, "availability")),
  }
}

const MAX_RUNNING = 5

export function compactQueue(queue: JsonObject): JsonObject {
  const running = objectList(queue.running)
  return {
    ...pick(queue, [
      "id",
      "active",
      "waiting",
      "completed",
      "failed",
      "paused",
      "retryAfterSeconds",
    ]),
    running: running.slice(0, MAX_RUNNING).map((job) => ({
      label: clip(job.label, MAX_TEXT_CHARS),
      startedAt: job.startedAt ?? null,
    })),
    ...(running.length > MAX_RUNNING
      ? { runningNotListed: running.length - MAX_RUNNING }
      : {}),
    failures: objectList(queue.failures).map((failure) => ({
      label: clip(failure.label, MAX_TEXT_CHARS),
      message: clip(failure.message, MAX_TEXT_CHARS),
      at: failure.at ?? null,
    })),
  }
}

export function compactTask(task: JsonObject): JsonObject {
  const lastRun = objectField(task, "lastRun")
  return {
    ...pick(task, ["id", "queue", "startedAt", "progress", "nextRunAt"]),
    lastRun: lastRun
      ? {
          ...pick(lastRun, ["endedAt", "result"]),
          error: clip(lastRun.error, MAX_TEXT_CHARS),
        }
      : null,
  }
}

export function compactMatch(match: JsonObject): JsonObject {
  return {
    ...pick(match, ["provider", "id"]),
    name: clip(match.name, MAX_NAME_CHARS),
    year: match.year ?? null,
    overview: clip(match.overview, 300),
  }
}
