/** Settings the chat gateways parse the same way, each under its own names. */

const SNOWFLAKE = /^\d{17,20}$/

/** The comma-separated ids in `name`, none when it is unset. */
export function ids(name: string, platform: string): ReadonlySet<string> {
  const values = (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
  const invalid = values.find((value) => !SNOWFLAKE.test(value))
  if (invalid !== undefined) {
    throw new Error(`${name} must list ${platform} ids, got "${invalid}"`)
  }
  return new Set(values)
}

/** The triage threshold in `name`, 0.8 when it is unset. */
export function threshold(name: string): number {
  const value = process.env[name]
  if (value === undefined || value.trim() === "") return 0.8
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${name} must be above 0 and at most 1, got "${value}"`)
  }
  return parsed
}
