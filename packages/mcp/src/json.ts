import type { JsonValue } from "./http.ts"

export type JsonObject = { [key: string]: JsonValue | undefined }

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === "number"
}

export function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string"
}

export function objectField(
  value: JsonObject | undefined,
  key: string,
): JsonObject | undefined {
  const field = value?.[key]
  return isJsonObject(field) ? field : undefined
}

/** The object entries of a list; anything else in it is dropped. */
export function objectList(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : []
}

/** The `name` of each entry, as Arr quality, language, and format lists use. */
export function names(value: JsonValue | undefined): string[] {
  return objectList(value).flatMap((item) =>
    isString(item.name) ? [item.name] : [],
  )
}

export function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter(isString) : []
}

export function numberList(value: JsonValue | undefined): number[] {
  return Array.isArray(value) ? value.filter(isNumber) : []
}

/** Copies the listed fields that are present. Compaction is mostly this. */
export function pick(
  record: JsonObject | undefined,
  keys: readonly string[],
): JsonObject {
  const picked: JsonObject = {}
  for (const key of keys) {
    const value = record?.[key]
    if (value !== undefined) picked[key] = value
  }
  return picked
}
