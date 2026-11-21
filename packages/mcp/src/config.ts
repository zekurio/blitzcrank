import path from "node:path"

export interface ServiceConfig {
  url: string
  apiKey: string
}

/**
 * Matinee with an admin account's token, for diagnosis and repairs, and
 * optionally an ordinary account's token, the only one that requests titles.
 */
export interface MatineeConfig {
  url: string
  apiKey: string
  /**
   * Its Matinee group sets what may be requested, whether requests wait for
   * approval, and the quota. Unset registers no tool that requests a title.
   */
  requestApiKey: string | undefined
}

export interface Config {
  /** Bearer token the host presents on every `/mcp` request. */
  token: string
  host: string
  port: number
  matinee: MatineeConfig | undefined
  sonarr: ServiceConfig | undefined
  radarr: ServiceConfig | undefined
  sabnzbd: ServiceConfig | undefined
  /** Absolute roots the media tools may read. Empty disables them. */
  mediaRoots: string[]
}

type Env = Record<string, string | undefined>

export function loadConfig(env: Env = process.env): Config {
  const config: Config = {
    token: requiredToken(env),
    host: env.BLITZCRANK_MCP_HOST?.trim() || "127.0.0.1",
    port: integer(env, "BLITZCRANK_MCP_PORT", 8485, 0, 65_535),
    matinee: matinee(env),
    sonarr: service(env, "SONARR"),
    radarr: service(env, "RADARR"),
    sabnzbd: service(env, "SABNZBD"),
    mediaRoots: mediaRoots(env),
  }
  const services = [
    config.matinee,
    config.sonarr,
    config.radarr,
    config.sabnzbd,
  ].filter((entry) => entry !== undefined)
  if (services.length === 0 && config.mediaRoots.length === 0) {
    throw new Error(
      "nothing to serve: set at least one <SERVICE>_URL and <SERVICE>_API_KEY pair or BLITZCRANK_MEDIA_ROOTS",
    )
  }
  return config
}

/** An empty token would authenticate every request that sends `Bearer `. */
function requiredToken(env: Env): string {
  const token = env.BLITZCRANK_MCP_TOKEN?.trim()
  if (!token) throw new Error("BLITZCRANK_MCP_TOKEN is required")
  return token
}

/** A pair with only one half set registers nothing. */
function service(env: Env, prefix: string): ServiceConfig | undefined {
  const url = env[`${prefix}_URL`]?.trim()
  const apiKey = env[`${prefix}_API_KEY`]?.trim()
  if (!url || !apiKey) return undefined
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new Error(`${prefix}_URL must be an http(s) URL`)
  }
  return { url: url.replace(/\/+$/, ""), apiKey }
}

/**
 * The admin token makes the pair. The request token rides on it: without the
 * admin token nothing of Matinee is registered, the requests included.
 */
function matinee(env: Env): MatineeConfig | undefined {
  const admin = service(env, "MATINEE")
  if (admin === undefined) return undefined
  const requestApiKey = env.MATINEE_REQUEST_API_KEY?.trim() || undefined
  if (requestApiKey === admin.apiKey) {
    throw new Error(
      "MATINEE_REQUEST_API_KEY must be an ordinary account's token, not MATINEE_API_KEY",
    )
  }
  return { ...admin, requestApiKey }
}

/** A port that silently becomes NaN would bind nowhere useful. */
function integer(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = env[name]
  if (value === undefined || value.trim() === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}, got "${value}"`,
    )
  }
  return parsed
}

/** `/` as a root would turn the media tools into a whole-host file reader. */
function mediaRoots(env: Env): string[] {
  const roots = (env.BLITZCRANK_MEDIA_ROOTS ?? "")
    .split(":")
    .map((root) => root.trim())
    .filter((root) => root !== "")
    .map((root) => path.normalize(root).replace(/(?<=.)\/+$/, ""))
  for (const root of roots) {
    if (!path.isAbsolute(root) || root === "/") {
      throw new Error(
        `BLITZCRANK_MEDIA_ROOTS entries must be absolute paths other than /, got "${root}"`,
      )
    }
  }
  return [...new Set(roots)]
}
