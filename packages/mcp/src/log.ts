/** Operational metadata only. Service payloads and arguments stay out of logs. */
export function logEvent(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
  level: "info" | "warn" | "error" = "info",
): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    component: "mcp",
    event,
    ...fields,
  })
  if (level === "error") return console.error(line)
  if (level === "warn") return console.warn(line)
  console.log(line)
}
