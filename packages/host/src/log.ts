type LogFields = Record<string, string | number | boolean | null | undefined>

/** Journald captures these JSON lines. Callers supply metadata, never payloads. */
export function logEvent(
  event: string,
  fields: LogFields = {},
  level: "info" | "warn" | "error" = "info",
): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    component: "host",
    event,
    ...fields,
  })
  if (level === "error") return console.error(line)
  if (level === "warn") return console.warn(line)
  console.log(line)
}

/** Error messages can contain credentials, response bodies, or reporter text. */
export function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError"
}
