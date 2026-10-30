import { Effect } from "effect"
import { Type, type Static } from "typebox"

import type { Signal } from "../../http.ts"
import { isNumber, isString, type JsonObject } from "../../json.ts"
import { toolFail, type ToolFailure } from "../../tools/errors.ts"
import type { Arr } from "../arr/client.ts"
import { readEpisodes, readSeries, seriesIdParam } from "./series.ts"

export const searchParams = Type.Object({
  seriesId: seriesIdParam,
  seasonNumber: Type.Optional(
    Type.Integer({ minimum: 0, description: "Search this season only" }),
  ),
  episodeIds: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), {
      minItems: 1,
      maxItems: 100,
      description: "Internal Sonarr episode ids for a targeted search",
    }),
  ),
})

export function searchCommand(
  params: Static<typeof searchParams>,
): JsonObject & { name: string } {
  if (params.episodeIds !== undefined) {
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

/** The episodes a search command reaches, resolved against the live series. */
export function searchScope(
  arr: Arr,
  params: Static<typeof searchParams>,
  signal: Signal,
): Effect.Effect<{ series: JsonObject; episodes: JsonObject[] }, ToolFailure> {
  return Effect.gen(function* () {
    if (params.episodeIds !== undefined && params.seasonNumber !== undefined) {
      return yield* toolFail("pass seasonNumber or episodeIds, not both")
    }
    const [series, all] = yield* Effect.all(
      [
        readSeries(arr, params.seriesId, signal),
        readEpisodes(arr, params.seriesId, signal, params.seasonNumber),
      ],
      { concurrency: "unbounded" },
    )
    if (params.episodeIds !== undefined) {
      const wanted = [...new Set(params.episodeIds)]
      const unknown = wanted.filter(
        (id) => !all.some((episode) => episode.id === id),
      )
      if (unknown.length > 0) {
        return yield* toolFail(
          `series ${params.seriesId} has no episode with id ${unknown.join(", ")}`,
        )
      }
      // An explicit episode search runs for unmonitored episodes too.
      return {
        series,
        episodes: all.filter(
          (episode) => isNumber(episode.id) && wanted.includes(episode.id),
        ),
      }
    }
    const season = params.seasonNumber
    if (
      season !== undefined &&
      !all.some((episode) => episode.seasonNumber === season)
    ) {
      return yield* toolFail(
        `series ${params.seriesId} has no season ${season}`,
      )
    }
    // Series and season searches skip unmonitored episodes.
    return {
      series,
      episodes: all.filter(
        (episode) =>
          episode.monitored === true &&
          (season === undefined || episode.seasonNumber === season),
      ),
    }
  })
}

export function unaired(episode: JsonObject, now: number): boolean {
  return !isString(episode.airDateUtc) || Date.parse(episode.airDateUtc) > now
}
