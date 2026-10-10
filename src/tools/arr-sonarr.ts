import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import type { JsonRequestError, JsonValue } from "../services/http.ts"
import {
  arrReadTool,
  arrRequest,
  manualImportTool,
  queueAndBlocklistTools,
  readReleases,
  releaseFilterParams,
  runArrCommand,
  runArrFileDelete,
  type JsonObject,
  type ReleaseTarget,
} from "./arr-common.ts"
import {
  reasonParam,
  textResult,
  toolCheck,
  type ServiceName,
  type ToolError,
} from "./common.ts"
import type { RunContext } from "./context.ts"

export interface ScopedEpisode {
  id: number
  seasonNumber: number
  monitored: boolean
  filePath: string | undefined
}

export function assertSearchScope(input: {
  episodes: ScopedEpisode[]
  expectedEpisodeCount: number | undefined
  probeAvailable: boolean
  probed: (filePath: string) => boolean
}): void {
  if (input.episodes.length === 0) {
    throw new Error(
      "scope gate: this search matches no monitored episode; nothing would be " +
        "searched. Check monitoring and the season number before acting.",
    )
  }
  if (
    input.episodes.length > 1 &&
    input.expectedEpisodeCount !== input.episodes.length
  ) {
    const replaced = input.episodes.filter((e) => e.filePath !== undefined)
    throw new Error(
      `scope gate: this search affects ${input.episodes.length} episodes ` +
        `(${replaced.length} already have a file and would be replaced). ` +
        `Pass expectedEpisodeCount: ${input.episodes.length} to confirm you intend that ` +
        "scope and have told the reporter the real number, or search a single episode " +
        "first with episodeIds to test the hypothesis at 1/N the cost.",
    )
  }
  const replacements = input.episodes.filter(
    (episode): episode is ScopedEpisode & { filePath: string } =>
      episode.filePath !== undefined,
  )
  if (replacements.length < 2 || !input.probeAvailable) return
  if (replacements.some((episode) => input.probed(episode.filePath))) return
  throw new Error(
    `evidence gate: this search would replace ${replacements.length} existing episode ` +
      "files, so it needs file-level evidence. Sonarr `languages`, `quality`, and custom " +
      "formats are parsed from the release name and never prove what a file contains: " +
      `probe at least one of the affected files with media_probe first (e.g. ${replacements[0]!.filePath}). ` +
      "If the probe shows the file already lacks the track, a re-grab of the same release cannot add it.",
  )
}

type SonarrEpisodeRecord = {
  [key: string]: JsonValue | undefined
  id: number
}

interface SonarrSearchParams {
  seriesId: number
  seasonNumber?: number | undefined
  episodeIds?: number[] | undefined
  expectedEpisodeCount?: number | undefined
}

function scopedEpisodes(
  cfg: ServiceConfig,
  params: SonarrSearchParams,
): Effect.Effect<ScopedEpisode[], JsonRequestError | ToolError> {
  return Effect.gen(function* () {
    const raw = yield* arrRequest(
      cfg,
      `/api/v3/episode?seriesId=${params.seriesId}&includeEpisodeFile=true`,
    )
    return yield* toolCheck(() => {
      if (!Array.isArray(raw)) {
        throw new Error(
          `could not read the episodes of series ${params.seriesId}; refusing to search with unknown scope`,
        )
      }
      const episodes = raw.filter(isSonarrEpisode).map(episodeScope)
      if (params.episodeIds && params.episodeIds.length > 0) {
        return selectedEpisodes(episodes, params.seriesId, params.episodeIds)
      }
      const monitored = episodes.filter((episode) => episode.monitored)
      if (params.seasonNumber === undefined) return monitored
      return monitored.filter(
        (episode) => episode.seasonNumber === params.seasonNumber,
      )
    })
  })
}

function episodeScope(episode: SonarrEpisodeRecord): ScopedEpisode {
  const episodeFile = isJsonObject(episode.episodeFile)
    ? episode.episodeFile
    : undefined
  return {
    id: episode.id,
    seasonNumber: isNumber(episode.seasonNumber) ? episode.seasonNumber : -1,
    monitored: episode.monitored === true,
    filePath:
      episode.hasFile === true && isString(episodeFile?.path)
        ? episodeFile.path
        : undefined,
  }
}

function isSonarrEpisode(value: JsonValue): value is SonarrEpisodeRecord {
  return isJsonObject(value) && isNumber(value.id)
}

function selectedEpisodes(
  episodes: ScopedEpisode[],
  seriesId: number,
  episodeIds: number[],
): ScopedEpisode[] {
  const byId = new Map(episodes.map((episode) => [episode.id, episode]))
  return [...new Set(episodeIds)].map((id) => {
    const episode = byId.get(id)
    if (!episode) {
      throw new Error(
        `episode id ${id} does not belong to series ${seriesId}; fetch the episodes again`,
      )
    }
    return episode
  })
}

function sonarrSearchTool(
  cfg: ServiceConfig,
  ctx: RunContext,
  probeAvailable: boolean,
): ToolRegistration {
  return defineTool({
    name: "sonarr_search",
    description:
      "Trigger a Sonarr search: whole series, one season, or specific episodes. The series id (and episode ids, if given) must come from Sonarr reads this run. " +
      "Scope is enforced: a search affecting more than one episode must state the true episode count in expectedEpisodeCount, and replacing two or more existing " +
      "episode files additionally requires that one of them was inspected with media_probe this run. Prefer one episode first to test a hypothesis.",
    parameters: Type.Object({
      reason: reasonParam(),
      seriesId: Type.Integer({
        minimum: 1,
        description: "Internal Sonarr series id (not tvdbId)",
      }),
      seasonNumber: Type.Optional(Type.Integer({ minimum: 0 })),
      episodeIds: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1 }), {
          description:
            "Internal Sonarr episode ids for a targeted EpisodeSearch",
        }),
      ),
      expectedEpisodeCount: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "How many episodes this search affects; required (and checked against Sonarr) when that is more than one",
        }),
      ),
    }),
    execute: (params) =>
      Effect.runPromise(executeSonarrSearch(cfg, ctx, probeAvailable, params)),
  })
}

function executeSonarrSearch(
  cfg: ServiceConfig,
  ctx: RunContext,
  probeAvailable: boolean,
  params: SonarrSearchParams,
) {
  return Effect.gen(function* () {
    const service: ServiceName = "sonarr"
    yield* toolCheck(() =>
      ctx.requireEvidence(service, params.seriesId, "series id"),
    )
    const episodes = yield* scopedEpisodes(cfg, params)
    yield* toolCheck(() =>
      assertSearchScope({
        episodes,
        expectedEpisodeCount: params.expectedEpisodeCount,
        probeAvailable,
        probed: (filePath) => ctx.sawProbe(filePath),
      }),
    )
    const command = sonarrSearchCommand(params)
    const evidence = [
      { service, value: params.seriesId, hint: "series id" },
      ...(params.episodeIds ?? []).map((id) => ({
        service,
        value: id,
        hint: "episode id",
      })),
    ]
    const outcome = yield* runArrCommand(cfg, service, ctx, evidence, command)
    return textResult(outcome, {
      service,
      action: "search",
      command: command.name,
      episodes: episodes.length,
    })
  })
}

function sonarrSearchCommand(
  params: SonarrSearchParams,
): Record<string, JsonValue> & { name: string } {
  if (params.episodeIds && params.episodeIds.length > 0) {
    return { name: "EpisodeSearch", episodeIds: params.episodeIds }
  }
  if (params.seasonNumber !== undefined) {
    return {
      name: "SeasonSearch",
      seriesId: params.seriesId,
      seasonNumber: params.seasonNumber,
    }
  }
  return { name: "SeriesSearch", seriesId: params.seriesId }
}

function isJsonObject(
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue | undefined } {
  return (
    value !== undefined &&
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value)
  )
}

function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === "number"
}

function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string"
}

function refreshSeriesTool(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration {
  return defineTool({
    name: "sonarr_refresh_series",
    description:
      "Refresh a series' metadata and rescan its files (RefreshSeries). The series id must come from a Sonarr read this run.",
    parameters: Type.Object({
      reason: reasonParam(),
      seriesId: Type.Integer({ minimum: 1 }),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const service: ServiceName = "sonarr"
          const evidence = [
            { service, value: params.seriesId, hint: "series id" },
          ]
          const outcome = yield* runArrCommand(cfg, service, ctx, evidence, {
            name: "RefreshSeries",
            seriesId: params.seriesId,
          })
          return textResult(outcome, {
            service,
            action: "refresh_series",
            seriesId: params.seriesId,
          })
        }),
      )
    },
  })
}

interface SonarrReleaseParams {
  episodeId?: number | undefined
  seriesId?: number | undefined
  seasonNumber?: number | undefined
}

function sonarrReleasesTool(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration {
  return defineTool({
    name: "sonarr_releases",
    replay: "safe",
    description:
      "List indexer release candidates for one episode (episodeId) or one season (seriesId and seasonNumber) with Sonarr's decision: " +
      "approved, rejections, custom-format score, publish date, languages, and mapped episodes. Runs a live indexer search; grabs nothing. " +
      "Counts cover every hit. The listing keeps Sonarr's preference order and is filtered and capped, so when matchingFilters exceeds " +
      "listed, narrow with publishedAfter, titleContains, or approvedOnly before concluding a release is absent. Releases Sonarr mapped " +
      "to other episodes are only counted.",
    parameters: Type.Object({
      ...releaseFilterParams(),
      episodeId: Type.Optional(
        Type.Integer({ minimum: 1, description: "Internal Sonarr episode id" }),
      ),
      seriesId: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Internal Sonarr series id, with seasonNumber",
        }),
      ),
      seasonNumber: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const service: ServiceName = "sonarr"
          const target = yield* toolCheck(() => sonarrReleaseTarget(params))
          const result = yield* readReleases(service, cfg, ctx, target, params)
          return textResult(result, {
            service,
            action: "releases",
            path: target.path,
          })
        }),
      )
    },
  })
}

function sonarrReleaseTarget(params: SonarrReleaseParams): ReleaseTarget {
  if (params.episodeId !== undefined) {
    if (params.seriesId !== undefined || params.seasonNumber !== undefined) {
      throw new Error(
        "pass either episodeId or seriesId with seasonNumber, not both",
      )
    }
    const episodeId = params.episodeId
    return {
      path: `/api/v3/release?episodeId=${episodeId}`,
      matches: (release) => mappedEpisodeIds(release).includes(episodeId),
      describe: describeMappedEpisodes,
    }
  }
  if (params.seriesId === undefined || params.seasonNumber === undefined) {
    throw new Error("pass episodeId, or seriesId with seasonNumber")
  }
  const seriesId = params.seriesId
  const seasonNumber = params.seasonNumber
  return {
    path: `/api/v3/release?seriesId=${seriesId}&seasonNumber=${seasonNumber}`,
    matches: (release) =>
      release.mappedSeriesId === seriesId &&
      release.mappedSeasonNumber === seasonNumber,
    describe: describeMappedEpisodes,
  }
}

function mappedEpisodeIds(release: JsonObject) {
  const info = release.mappedEpisodeInfo
  if (!Array.isArray(info)) return []
  return info.flatMap((episode) =>
    isJsonObject(episode) && isNumber(episode.id) ? [episode.id] : [],
  )
}

/** Scene and absolute numbering is where wrong-episode grabs show up. */
function describeMappedEpisodes(release: JsonObject) {
  const season = release.mappedSeasonNumber
  const episodes = numberList(release.mappedEpisodeNumbers)
  const absolute = numberList(release.mappedAbsoluteEpisodeNumbers)
  return {
    episodes:
      release.fullSeason === true
        ? `S${season} full season`
        : `S${season}E${episodes.join(",")}`,
    ...(absolute.length > 0 ? { absolute } : {}),
  }
}

function numberList(value: JsonValue | undefined): number[] {
  return Array.isArray(value) ? value.filter(isNumber) : []
}

function deleteEpisodeFileTool(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration {
  return defineTool({
    name: "sonarr_delete_episode_file",
    description:
      "Delete one episode file from disk (e.g. verified corrupt), so a replacement can be searched. Call it once per file when a whole verified set is wrong. The episodefile id must pass the Sonarr evidence gate.",
    parameters: Type.Object({
      reason: reasonParam(),
      episodeFileId: Type.Integer({ minimum: 1 }),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const service: ServiceName = "sonarr"
          const path = `/api/v3/episodefile/${params.episodeFileId}`
          const outcome = yield* runArrFileDelete(
            cfg,
            service,
            ctx,
            path,
            params.episodeFileId,
            "episodefile id",
            "episode file",
          )
          return textResult(outcome, {
            service,
            action: "delete_episode_file",
            episodeFileId: params.episodeFileId,
          })
        }),
      )
    },
  })
}

export function buildSonarrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
  probeAvailable: boolean,
): ToolRegistration[] {
  const service: ServiceName = "sonarr"
  return [
    arrReadTool(
      service,
      cfg,
      ctx,
      "Sonarr read",
      "Check series/episode availability and air dates in Sonarr via GET /api/v3 paths: " +
        "series/episode for tracking/monitoring, episodefile for imported files, queue/history for acquisition, " +
        "calendar for episode air dates, blocklist, wanted/missing. " +
        "Load the sonarr skill for exact availability/date workflows.",
    ),
    sonarrReleasesTool(cfg, ctx),
    sonarrSearchTool(cfg, ctx, probeAvailable),
    refreshSeriesTool(cfg, ctx),
    deleteEpisodeFileTool(cfg, ctx),
    manualImportTool(service, cfg, ctx),
    ...queueAndBlocklistTools(service, cfg, ctx),
  ]
}
