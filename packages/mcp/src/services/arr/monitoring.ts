import { Effect } from "effect"

import type { JsonValue } from "../../http.ts"
import { isNumber, isString, type JsonObject } from "../../json.ts"
import { toolCheck, type ToolFailure } from "../../tools/errors.ts"

export interface MonitoringUpdate {
  id: number
  noun: string
  /** External identity that a body without it would reset to 0. */
  identity: "tvdbId" | "tmdbId"
  /** Fields that must read back exactly as they were sent. */
  preserved: readonly string[]
  /** The monitoring fields the read-back must match. */
  monitoring: (record: JsonObject) => JsonObject
}

/**
 * Arr PUT replaces the whole record: an omitted field deserializes to its
 * default (identity 0, no seasons, no path). A record that reads back without
 * its essentials must therefore never be sent back.
 */
export function arrRecord(
  value: JsonObject,
  update: MonitoringUpdate,
): Effect.Effect<JsonObject, ToolFailure> {
  return toolCheck(() => {
    if (value.id !== update.id) {
      throw new Error(
        `${update.noun} ${update.id} did not read back as that record`,
      )
    }
    const identity = value[update.identity]
    if (
      !isNumber(identity) ||
      identity < 1 ||
      !isString(value.path) ||
      value.path === "" ||
      !isNumber(value.qualityProfileId) ||
      typeof value.monitored !== "boolean"
    ) {
      throw new Error(
        `${update.noun} ${update.id} read back without a valid ${update.identity}, path, qualityProfileId, or monitored`,
      )
    }
    return value
  })
}

export function monitoringReadBack(
  record: JsonObject,
  sent: JsonObject,
  update: MonitoringUpdate,
): JsonValue {
  const monitoring = update.monitoring(record)
  const changed = update.preserved.filter(
    (field) => JSON.stringify(record[field]) !== JSON.stringify(sent[field]),
  )
  if (
    changed.length === 0 &&
    JSON.stringify(monitoring) === JSON.stringify(update.monitoring(sent))
  ) {
    return {
      confirmed: "monitoring applied; other fields unchanged",
      monitoring,
    }
  }
  return {
    warning:
      changed.length > 0
        ? `read-back differs in ${changed.join(", ")}`
        : "read-back monitoring differs from the request",
    monitoring,
  }
}
