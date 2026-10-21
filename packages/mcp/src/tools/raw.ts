import { Effect } from "effect"

import type { JsonValue } from "../http.ts"
import { isJsonObject, type JsonObject } from "../json.ts"
import { toolCheck, ToolError } from "./errors.ts"

const PLACEHOLDER_ORIGIN = "http://service.invalid"

export function rawPath(
  path: string,
  prefix: string,
): Effect.Effect<string, ToolError> {
  return toolCheck(() => {
    const resolved = URL.canParse(path.slice(1), `${PLACEHOLDER_ORIGIN}/`)
      ? new URL(path.slice(1), `${PLACEHOLDER_ORIGIN}/`)
      : undefined
    if (
      !path.startsWith("/") ||
      resolved === undefined ||
      resolved.origin !== PLACEHOLDER_ORIGIN ||
      !(resolved.pathname + "/").startsWith(prefix.replace(/\/*$/, "/"))
    ) {
      throw new Error(
        `path must be a service-relative path below ${prefix}, with its query string and no host`,
      )
    }
    return resolved.pathname + resolved.search
  })
}

const SECRET_NAME =
  /api_?key|token|pass|secret|credential|cookie|webhook|private/i

export function rawResult(
  response: JsonValue | undefined,
  secrets: readonly string[],
): JsonObject {
  return { response: redact(response ?? null, secrets) }
}

function redact(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === "string") {
    return secrets.reduce(
      (text, secret) => text.replaceAll(secret, "[redacted]"),
      value,
    )
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets))
  if (!isJsonObject(value)) return value
  const named = typeof value.name === "string" && SECRET_NAME.test(value.name)
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, member]) => {
      if (member === undefined) return []
      const secret = SECRET_NAME.test(key) || (named && key === "value")
      if (secret && typeof member === "string" && member !== "") {
        return [[key, "[redacted]"]]
      }
      return [[key, redact(member, secrets)]]
    }),
  )
}
