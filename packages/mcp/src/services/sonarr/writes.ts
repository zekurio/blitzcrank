import { Effect } from "effect"
import { Type } from "typebox"

import type { JsonValue } from "../../http.ts"
import { isJsonObject, isNumber, objectField, objectList } from "../../json.ts"
import { toolCheck, toolFail } from "../../tools/errors.ts"
import { action, type WriteEffect } from "../../tools/writes.ts"
import { arrList, arrObject, arrRequest, type Arr } from "../arr/client.ts"
import { postCommand, verifyCommand, verifyDeleted } from "../arr/commands.ts"
import { qualityName, sizeText } from "../arr/compact.ts"
import {
  candidateFile,
  candidateWarnings,
  folderScanAction,
  manualImportScope,
  matchCandidates,
} from "../arr/manual-import.ts"
import { arrRecord, monitoringReadBack } from "../arr/monitoring.ts"
import { arrSharedActions } from "../arr/writes.ts"
import {
  patchSeriesMonitoring,
  seriesMonitoringEffects,
  seriesMonitoringParams,
  seriesMonitoringUpdate,
} from "./monitoring.ts"
import { searchCommand, searchParams, searchScope, unaired } from "./search.ts"
import {
  compactSeries,
  episodeLabel,
  readEpisodes,
  readEpisodesById,
  readSeries,
  seriesIdParam,
} from "./series.ts"

const manualImportFile = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description:
        "Candidate path, exactly as sonarr_manual_import_candidates has it",
    }),
    seriesId: seriesIdParam,
    episodeIds: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false },
)

const COMMANDS = [
  "RefreshSeries",
  "RescanSeries",
  "RefreshMonitoredDownloads",
] as const

export function sonarrActions(arr: Arr) {
  const shared = arrSharedActions(arr)
  return {
    auto_search: action({
      description:
        "Search indexers for the whole series, one season, or specific episodes. Sonarr picks and grabs the release",
      params: searchParams,
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const scope = yield* searchScope(arr, params, signal)
          const command = searchCommand(params)
          const title = String(
            scope.series.title ?? `series ${params.seriesId}`,
          )
          if (scope.episodes.length === 0) {
            return yield* toolFail(
              `${command.name} would search nothing: no monitored episode in scope for ${title}`,
            )
          }
          const withFiles = scope.episodes.filter(
            (episode) => episode.hasFile === true,
          )
          const notAired = scope.episodes.filter((episode) =>
            unaired(episode, Date.now()),
          )
          const unmonitored = scope.episodes.filter(
            (episode) => episode.monitored !== true,
          )
          const target =
            params.episodeIds !== undefined
              ? `${title}: ${scope.episodes.map(episodeLabel).join(", ")}`
              : params.seasonNumber !== undefined
                ? `${title} season ${params.seasonNumber}`
                : `${title}, every season`
          const counts = `${scope.episodes.length} episode(s), ${withFiles.length} with files`
          const effect: WriteEffect = {
            kind: "search",
            target,
            detail: counts,
          }
          return {
            state: null,
            summary: `${command.name} for ${target}: ${counts}${withFiles.length > 0 ? " that a grab may replace" : ""}`,
            effects: [effect],
            warnings: [
              ...(notAired.length > 0
                ? [`${notAired.length} episode(s) in scope have not aired`]
                : []),
              ...(unmonitored.length > 0
                ? [
                    `${unmonitored.length} named episode(s) are unmonitored and are searched anyway`,
                  ]
                : []),
              ...(scope.series.monitored !== true
                ? ["the series itself is unmonitored"]
                : []),
              ...(params.episodeIds === undefined &&
              params.seasonNumber === undefined
                ? ["this searches the whole series"]
                : []),
            ],
          }
        }),
      write: (params) => postCommand(arr, searchCommand(params)),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
    set_series_monitoring: action({
      description:
        "Change a series' monitored flag, named seasons, or monitorNewItems. Every other series field is kept",
      params: seriesMonitoringParams,
      lock: (params) => `series:${params.seriesId}`,
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const update = seriesMonitoringUpdate(params.seriesId)
          const record = yield* arrRecord(
            yield* readSeries(arr, params.seriesId, signal),
            update,
          )
          const effects = yield* toolCheck(() =>
            seriesMonitoringEffects(
              params.seriesId,
              record,
              patchSeriesMonitoring(record, params),
            ),
          )
          if (effects.length === 0) {
            return yield* toolFail(
              `series ${params.seriesId} already has that monitoring; there is nothing to change`,
            )
          }
          return {
            state: { record },
            summary: `Change monitoring of ${String(record.title ?? `series ${params.seriesId}`)}: ${effects.length} field(s)`,
            effects,
            warnings: effects.some((effect) => effect.target.includes("season"))
              ? [
                  "a season's flag overrides the per-episode monitoring inside it",
                ]
              : [],
          }
        }),
      write: (params, state) =>
        Effect.gen(function* () {
          const body = yield* toolCheck(() =>
            patchSeriesMonitoring(state.record, params),
          )
          const written = yield* arrRequest(
            arr,
            `/api/v3/series/${params.seriesId}`,
            { method: "PUT", body },
          )
          return isJsonObject(written) ? compactSeries(written) : written
        }),
      verify: (params, _result, state) =>
        Effect.gen(function* () {
          const update = seriesMonitoringUpdate(params.seriesId)
          const after = yield* arrRecord(
            yield* readSeries(arr, params.seriesId, undefined),
            update,
          )
          return yield* toolCheck(() =>
            monitoringReadBack(
              after,
              patchSeriesMonitoring(state.record, params),
              update,
            ),
          )
        }),
    }),
    set_episode_monitoring: action({
      description: "Set the monitored flag of specific episodes",
      params: Type.Object({
        episodeIds: Type.Array(Type.Integer({ minimum: 1 }), {
          minItems: 1,
          maxItems: 100,
          description: "Internal Sonarr episode ids",
        }),
        monitored: Type.Boolean(),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const episodes = yield* readEpisodesById(
            arr,
            params.episodeIds,
            signal,
          )
          const changing = episodes.filter(
            (episode) => episode.monitored !== params.monitored,
          )
          if (changing.length === 0) {
            return yield* toolFail(
              `every named episode already has monitored=${params.monitored}; there is nothing to change`,
            )
          }
          return {
            state: null,
            summary: `Set monitored=${params.monitored} on ${changing.length} episode(s)`,
            effects: changing.map(
              (episode): WriteEffect => ({
                kind: "update",
                target: `episode ${String(episode.id)} (${episodeLabel(episode)}) monitored`,
                detail: `${String(episode.monitored)} -> ${params.monitored}`,
              }),
            ),
            warnings:
              changing.length < episodes.length
                ? [
                    `${episodes.length - changing.length} named episode(s) already have monitored=${params.monitored}`,
                  ]
                : [],
          }
        }),
      write: (params) =>
        arrRequest(arr, "/api/v3/episode/monitor", {
          method: "PUT",
          body: { episodeIds: params.episodeIds, monitored: params.monitored },
        }).pipe(
          Effect.map((): JsonValue => ({ updated: params.episodeIds.length })),
        ),
      verify: (params) =>
        readEpisodesById(arr, params.episodeIds, undefined).pipe(
          Effect.map((episodes): JsonValue => {
            const flags = episodes.map((episode) => ({
              id: episode.id ?? null,
              monitored: episode.monitored ?? null,
            }))
            return episodes.every(
              (episode) => episode.monitored === params.monitored,
            )
              ? { confirmed: "episode monitoring applied", episodes: flags }
              : {
                  warning: "read-back monitoring differs from the request",
                  episodes: flags,
                }
          }),
        ),
    }),
    delete_episode_file: action({
      description:
        "Delete one episode file from disk so a replacement can be searched",
      params: Type.Object({ episodeFileId: Type.Integer({ minimum: 1 }) }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const file = yield* arrObject(
            arr,
            `/api/v3/episodefile/${params.episodeFileId}`,
            `episode file ${params.episodeFileId}`,
            signal,
          )
          const episodes = yield* arrList(arr, "/api/v3/episode", {
            query: { episodeFileId: params.episodeFileId },
            signal,
          })
          const covered =
            episodes.length > 0
              ? episodes.map(episodeLabel).join(", ")
              : "no episode"
          const path = String(
            file.path ?? `episode file ${params.episodeFileId}`,
          )
          const effect: WriteEffect = {
            kind: "delete",
            target: path,
            detail: `${sizeText(file.size)}; covers ${covered}`,
          }
          return {
            state: null,
            summary: `Delete episode file ${params.episodeFileId} (${path}, ${sizeText(file.size)}), covering ${covered}`,
            effects: [effect],
            warnings: [
              "the file is removed from disk",
              ...(episodes.length > 1
                ? [`this one file holds ${episodes.length} episodes`]
                : []),
            ],
          }
        }),
      write: (params) =>
        arrRequest(arr, `/api/v3/episodefile/${params.episodeFileId}`, {
          method: "DELETE",
        }).pipe(
          Effect.map(
            (): JsonValue => ({
              deleted: `episode file ${params.episodeFileId}`,
            }),
          ),
        ),
      verify: (params) =>
        verifyDeleted(
          arr,
          `/api/v3/episodefile/${params.episodeFileId}`,
          "episode file",
        ),
    }),
    remove_queue_item: shared.remove_queue_item,
    mark_history_failed: shared.mark_history_failed,
    delete_blocklist_entry: shared.delete_blocklist_entry,
    grab_release: shared.grab_release,
    manual_import: action({
      description:
        "Import files Sonarr offers as manual-import candidates into named episodes. " +
        "Quality, languages, and release group come from the live candidate",
      params: Type.Object({
        files: Type.Array(manualImportFile, { minItems: 1, maxItems: 50 }),
        importMode: Type.Enum(["auto", "move", "copy"], {
          description: "move for a finished download",
        }),
        ...manualImportScope(),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const matches = yield* matchCandidates(
            arr,
            params,
            params.files.map((file) => file.path),
            signal,
          )
          const seriesIds = [
            ...new Set(params.files.map((file) => file.seriesId)),
          ]
          const targets = new Map(
            yield* Effect.forEach(seriesIds, (seriesId) =>
              Effect.gen(function* () {
                const series = yield* readSeries(arr, seriesId, signal)
                const episodes = yield* readEpisodes(arr, seriesId, signal)
                return [seriesId, { series, episodes }] as const
              }),
            ),
          )
          const effects: WriteEffect[] = []
          for (const file of params.files) {
            const target = targets.get(file.seriesId)
            const match = matches.find((entry) => entry.path === file.path)
            const episodes = (target?.episodes ?? []).filter(
              (episode) =>
                isNumber(episode.id) && file.episodeIds.includes(episode.id),
            )
            if (episodes.length !== new Set(file.episodeIds).size) {
              return yield* toolFail(
                `series ${file.seriesId} does not have every episode id named for ${file.path}`,
              )
            }
            effects.push({
              kind: "import",
              target: file.path,
              detail: `${params.importMode} into ${String(target?.series.title ?? `series ${file.seriesId}`)} ${episodes.map(episodeLabel).join(", ")} as ${String(qualityName(match?.candidate.quality) ?? "unknown quality")}`,
            })
          }
          return {
            state: { matches },
            summary: `Manual import of ${params.files.length} file(s), mode ${params.importMode}`,
            effects,
            warnings: candidateWarnings(matches),
          }
        }),
      write: (params, state) =>
        postCommand(arr, {
          name: "ManualImport",
          importMode: params.importMode,
          files: state.matches.flatMap((match) => {
            const file = params.files.find((entry) => entry.path === match.path)
            if (!file) return []
            return [
              {
                ...candidateFile(match, params.downloadId),
                seriesId: file.seriesId,
                episodeIds: file.episodeIds,
              },
            ]
          }),
        }),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
    scan_import_folder: folderScanAction(
      arr,
      (candidate) =>
        `${String(objectField(candidate, "series")?.title ?? "no series")} ${objectList(candidate.episodes).map(episodeLabel).join(", ") || "no episode"}`,
    ),
    run_command: action({
      description:
        "Make Sonarr re-read disk or downloader state. RefreshSeries and RescanSeries need seriesId; RefreshMonitoredDownloads covers every download and takes none",
      params: Type.Object({
        name: Type.Enum(COMMANDS),
        seriesId: Type.Optional(seriesIdParam),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          if (params.name === "RefreshMonitoredDownloads") {
            if (params.seriesId !== undefined) {
              return yield* toolFail(
                "RefreshMonitoredDownloads covers every download and takes no seriesId",
              )
            }
            return {
              state: null,
              summary:
                "Re-check every monitored download in the download clients",
              effects: [
                {
                  kind: "command",
                  target: "download clients",
                  detail: "RefreshMonitoredDownloads",
                },
              ],
              warnings: [],
            }
          }
          if (params.seriesId === undefined) {
            return yield* toolFail(`${params.name} needs seriesId`)
          }
          const series = yield* readSeries(arr, params.seriesId, signal)
          return {
            state: null,
            summary: `${params.name} for ${String(series.title ?? `series ${params.seriesId}`)}`,
            effects: [
              {
                kind: "command",
                target: `series ${params.seriesId}: ${String(series.title ?? "")}`,
                detail: `${params.name} over ${String(series.path ?? "its folder")}`,
              },
            ],
            warnings: [],
          }
        }),
      write: (params) =>
        postCommand(arr, {
          name: params.name,
          ...(params.name === "RefreshSeries" || params.name === "RescanSeries"
            ? { seriesId: params.seriesId }
            : {}),
        }),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
  }
}
