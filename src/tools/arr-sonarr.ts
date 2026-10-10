import { StringEnum } from "@earendil-works/pi-ai"
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import type { JsonRequestError, JsonValue } from "../services/http.ts"
import {
  arrRequest,
  arrRequestTool,
  deleteQueueItemTool,
  runArrCommand,
  runArrFileDelete,
  runArrMonitoringUpdate,
  type ArrRecord,
} from "./arr-common.ts"
import {
  reasonParam,
  textResult,
  toolCheck,
  type HostTool,
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
    // A repeated search duplicates no data; Sonarr skips releases it already has.
    replay: "safe",
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
    const service = "sonarr" as const
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
          const service = "sonarr" as const
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

interface SeriesMonitoringParams {
  seriesId: number
  monitored?: boolean | undefined
  seasons?: Array<{ seasonNumber: number; monitored: boolean }> | undefined
  monitorNewItems?: "all" | "none" | undefined
}

type SeasonRecord = ArrRecord & { seasonNumber: number; monitored: boolean }

function setSeriesMonitoringTool(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration {
  return defineTool({
    name: "sonarr_set_series_monitoring",
    description:
      "Change a Sonarr series' monitoring: the series flag, named seasons, and monitorNewItems (Sonarr v4). " +
      "Reads the current series and sends it back with only those fields changed, so path, profiles, " +
      "identity, and unnamed seasons stay as they are. Changing a season's flag also sets every episode " +
      "in that season to match. For single episodes use PUT /api/v3/episode/monitor via sonarr_request. " +
      "The series id must pass the Sonarr evidence gate.",
    parameters: Type.Object({
      reason: reasonParam(),
      seriesId: Type.Integer({
        minimum: 1,
        description: "Internal Sonarr series id (not tvdbId)",
      }),
      monitored: Type.Optional(
        Type.Boolean({ description: "Series-level monitoring" }),
      ),
      seasons: Type.Optional(
        Type.Array(
          Type.Object({
            seasonNumber: Type.Integer({ minimum: 0 }),
            monitored: Type.Boolean(),
          }),
          { minItems: 1, description: "Seasons to change; others are kept" },
        ),
      ),
      monitorNewItems: Type.Optional(
        StringEnum(["all", "none"] as const, {
          description: "Whether seasons Sonarr adds later are monitored",
        }),
      ),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const service = "sonarr" as const
          const outcome = yield* runArrMonitoringUpdate(cfg, service, ctx, {
            path: `/api/v3/series/${params.seriesId}`,
            id: params.seriesId,
            hint: "series id",
            identity: "tvdbId",
            preserved: [
              "tvdbId",
              "path",
              "qualityProfileId",
              "languageProfileId",
              "seriesType",
              "seasonFolder",
              "tags",
            ],
            patch: (record) => patchSeriesMonitoring(record, params),
            monitoring: (record) => ({
              monitored: record.monitored ?? null,
              monitorNewItems: record.monitorNewItems ?? null,
              seasons: seasonRecords(record).map((season) => ({
                seasonNumber: season.seasonNumber,
                monitored: season.monitored,
              })),
            }),
          })
          return textResult(outcome, {
            service,
            action: "set_series_monitoring",
            seriesId: params.seriesId,
          })
        }),
      )
    },
  })
}

function patchSeriesMonitoring(
  record: ArrRecord,
  params: SeriesMonitoringParams,
): ArrRecord {
  if (
    params.monitored === undefined &&
    params.seasons === undefined &&
    params.monitorNewItems === undefined
  ) {
    throw new Error("name monitored, seasons, or monitorNewItems to change")
  }
  const seasons = seasonRecords(record)
  const requested = new Map<number, boolean>()
  for (const season of params.seasons ?? []) {
    if (requested.has(season.seasonNumber)) {
      throw new Error(`season ${season.seasonNumber} is named twice`)
    }
    if (!seasons.some((s) => s.seasonNumber === season.seasonNumber)) {
      throw new Error(
        `series ${params.seriesId} has no season ${season.seasonNumber}; nothing was written`,
      )
    }
    requested.set(season.seasonNumber, season.monitored)
  }
  if (params.monitorNewItems !== undefined && !isString(record.monitorNewItems))
    throw new Error(
      "this Sonarr has no monitorNewItems setting; nothing was written",
    )
  return {
    ...record,
    ...(params.monitored !== undefined ? { monitored: params.monitored } : {}),
    ...(params.monitorNewItems !== undefined
      ? { monitorNewItems: params.monitorNewItems }
      : {}),
    seasons: seasons.map((season) => {
      const monitored = requested.get(season.seasonNumber)
      return monitored === undefined ? season : { ...season, monitored }
    }),
  }
}

/** The PUT sends every season back, so a malformed list must never be sent. */
function seasonRecords(record: ArrRecord): SeasonRecord[] {
  const seasons = record.seasons
  if (!Array.isArray(seasons) || !seasons.every(isSeasonRecord)) {
    throw new Error(
      `series ${String(record.id)} read back without a valid seasons list`,
    )
  }
  return seasons
}

function isSeasonRecord(value: JsonValue): value is SeasonRecord {
  return (
    isJsonObject(value) &&
    Number.isInteger(value.seasonNumber) &&
    typeof value.monitored === "boolean"
  )
}

export function buildSonarrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
  probeAvailable: boolean,
): HostTool[] {
  return [
    arrRequestTool(
      "sonarr",
      cfg,
      ctx,
      "Sonarr API under /api/v3. GET reads series, episodes, files, queue, history, releases, calendar, " +
        "blocklist, and profiles. Writes: PUT episode/{id} and PUT episode/monitor (episode monitoring), POST command (RefreshSeries, " +
        "RescanSeries, ManualImport, DownloadedEpisodesScan, RefreshMonitoredDownloads), POST queue/grab/{id}, " +
        "POST history/failed/{id}, DELETE blocklist/{id}, POST release, and DELETE queue/{id}?removeFromClient=false. " +
        "Searches go through sonarr_search, series and season monitoring through sonarr_set_series_monitoring, " +
        "deletions through the delete tools; server settings are refused. " +
        "Load the sonarr skill for workflows.",
    ),
    sonarrSearchTool(cfg, ctx, probeAvailable),
    setSeriesMonitoringTool(cfg, ctx),
    deleteEpisodeFileTool(cfg, ctx),
    deleteQueueItemTool("sonarr", cfg, ctx),
  ]
}
