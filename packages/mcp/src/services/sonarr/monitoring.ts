import { Type, type Static } from "typebox"

import type { JsonValue } from "../../http.ts"
import { isJsonObject, isString, type JsonObject } from "../../json.ts"
import type { WriteEffect } from "../../tools/writes.ts"
import type { MonitoringUpdate } from "../arr/monitoring.ts"
import { seriesIdParam } from "./series.ts"

export const seriesMonitoringParams = Type.Object({
  seriesId: seriesIdParam,
  monitored: Type.Optional(
    Type.Boolean({ description: "Series-level monitoring" }),
  ),
  seasons: Type.Optional(
    Type.Array(
      Type.Object(
        {
          seasonNumber: Type.Integer({ minimum: 0 }),
          monitored: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        description:
          "Seasons to change; others are kept. A season's flag also sets every episode in it",
      },
    ),
  ),
  monitorNewItems: Type.Optional(
    Type.Enum(["all", "none"], {
      description: "Whether seasons Sonarr adds later are monitored",
    }),
  ),
})

const SERIES_PRESERVED = [
  "tvdbId",
  "path",
  "qualityProfileId",
  "languageProfileId",
  "seriesType",
  "seasonFolder",
  "tags",
] as const

type SeasonRecord = JsonObject & { seasonNumber: number; monitored: boolean }

export function seriesMonitoringUpdate(seriesId: number): MonitoringUpdate {
  return {
    id: seriesId,
    noun: "series",
    identity: "tvdbId",
    preserved: SERIES_PRESERVED,
    monitoring: (record) => ({
      monitored: record.monitored ?? null,
      monitorNewItems: record.monitorNewItems ?? null,
      seasons: seasonRecords(record).map((season) => ({
        seasonNumber: season.seasonNumber,
        monitored: season.monitored,
      })),
    }),
  }
}

/** Applies the requested monitoring to a copy; throws on an invalid request. */
export function patchSeriesMonitoring(
  record: JsonObject,
  params: Static<typeof seriesMonitoringParams>,
): JsonObject {
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
        `series ${params.seriesId} has no season ${season.seasonNumber}`,
      )
    }
    requested.set(season.seasonNumber, season.monitored)
  }
  if (params.monitorNewItems !== undefined && !isString(record.monitorNewItems))
    throw new Error("this Sonarr has no monitorNewItems setting")
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
function seasonRecords(record: JsonObject): SeasonRecord[] {
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

/** The field-level changes a monitoring patch makes, one effect per field. */
export function seriesMonitoringEffects(
  seriesId: number,
  before: JsonObject,
  after: JsonObject,
): WriteEffect[] {
  const effects: WriteEffect[] = []
  for (const field of ["monitored", "monitorNewItems"]) {
    if (before[field] !== after[field]) {
      effects.push({
        kind: "update",
        target: `series ${seriesId} ${field}`,
        detail: `${String(before[field])} -> ${String(after[field])}`,
      })
    }
  }
  const previous = new Map(
    seasonRecords(before).map((season) => [
      season.seasonNumber,
      season.monitored,
    ]),
  )
  for (const season of seasonRecords(after)) {
    if (previous.get(season.seasonNumber) !== season.monitored) {
      effects.push({
        kind: "update",
        target: `series ${seriesId} season ${season.seasonNumber} monitored`,
        detail: `${String(previous.get(season.seasonNumber))} -> ${season.monitored}; every episode in the season follows`,
      })
    }
  }
  return effects
}
