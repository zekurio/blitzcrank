/**
 * Route policy for the raw `<service>_request` tools.
 *
 * Reads and media-pipeline writes pass. Deletions are refused here and go
 * through the dedicated, gated delete tools. Everything else, meaning server
 * administration (settings, credentials, users, indexers, download clients,
 * system state, library membership), is refused outright: the agent hands
 * that step to an admin instead of looking for a workaround.
 *
 * Write rules are allowlists, so an unknown route is administration.
 */

export type Method = "GET" | "POST" | "PUT" | "DELETE"

export type Route =
  | { kind: "read" }
  | { kind: "write" }
  | { kind: "refused"; message: string }

const READ: Route = { kind: "read" }
const WRITE: Route = { kind: "write" }

const ADMIN: Route = {
  kind: "refused",
  message:
    "Refused: this is server administration, which blitzcrank never touches. " +
    "Do not look for a workaround. Tell the reporter what an admin needs to do.",
}

function refused(message: string): Route {
  return { kind: "refused", message: `Refused: ${message}` }
}

function deletion(tool: string): Route {
  return refused(`this deletes data. Use ${tool}, which gates deletions.`)
}

export function assertServicePath(path: string): void {
  if (!path.startsWith("/")) {
    throw new Error("path must be service-relative and start with /")
  }
  if (
    path.startsWith("//") ||
    /[\r\n#\\]/.test(path) ||
    /^https?:\/\//i.test(path) ||
    /apikey|api_key|token/i.test(path)
  ) {
    throw new Error("path must not contain full URLs or credentials")
  }
}

interface ParsedPath {
  /** Lowercased, non-empty path segments. */
  segments: string[]
  /** First value per lowercased query key; ASP.NET binds keys case-insensitively. */
  query: Map<string, string>
  /** Exact query pairs, for services whose keys are case-sensitive. */
  pairs: Array<[string, string]>
}

function parsePath(path: string): ParsedPath | undefined {
  const url = new URL(path, "http://service.invalid")
  // Encoded separators would let a denied segment hide from the rules below.
  if (url.host !== "service.invalid" || url.pathname.includes("%"))
    return undefined
  const pairs = [...url.searchParams]
  const query = new Map<string, string>()
  for (const [key, value] of pairs) {
    if (!query.has(key.toLowerCase())) query.set(key.toLowerCase(), value)
  }
  return {
    segments: url.pathname.toLowerCase().split("/").filter(Boolean),
    query,
    pairs,
  }
}

/** `:id` matches a numeric id, `:guid` an item id, anything else literally. */
function matches(segments: string[], pattern: string): boolean {
  const parts = pattern.split("/")
  return (
    parts.length === segments.length &&
    parts.every((part, index) => {
      const segment = segments[index]!
      if (part === ":id") return /^\d+$/.test(segment)
      if (part === ":guid") return /^[0-9a-f-]+$/.test(segment)
      return part === segment
    })
  )
}

/** A boolean query flag; anything but an explicit `false` counts as set. */
function flag(query: Map<string, string>, key: string, fallback: boolean) {
  const value = query.get(key)
  if (value === undefined) return fallback
  return value.toLowerCase() !== "false"
}

const ARR_READ_DENIED = new Set([
  "config",
  "indexer",
  "downloadclient",
  "notification",
  "importlist",
  "metadata",
  "log",
  "update",
  "filesystem",
  "system",
])

const ARR_READ_ALLOWED = new Set([
  "config/naming",
  "config/mediamanagement",
  "system/status",
])

const ARR_COMMANDS: Record<"sonarr" | "radarr", ReadonlySet<string>> = {
  sonarr: new Set([
    "refreshseries",
    "rescanseries",
    "manualimport",
    "downloadedepisodesscan",
    "refreshmonitoreddownloads",
  ]),
  radarr: new Set([
    "refreshmovie",
    "rescanmovie",
    "moviessearch",
    "manualimport",
    "downloadedmoviesscan",
    "refreshmonitoreddownloads",
  ]),
}

const SONARR_SEARCHES = new Set([
  "episodesearch",
  "seasonsearch",
  "seriessearch",
  "missingepisodesearch",
  "cutoffunmetepisodesearch",
])

export function arrRoute(
  service: "sonarr" | "radarr",
  method: Method,
  path: string,
  body: unknown,
): Route {
  const parsed = parsePath(path)
  if (!parsed || parsed.segments[0] !== "api" || parsed.segments[1] !== "v3")
    return refused("paths start with /api/v3/")
  const resource = parsed.segments.slice(2)
  const query = parsed.query

  if (method === "GET") {
    if (ARR_READ_ALLOWED.has(resource.join("/"))) return READ
    return ARR_READ_DENIED.has(resource[0] ?? "") ? ADMIN : READ
  }

  const media = service === "sonarr" ? "series" : "movie"
  const write = (m: Method, pattern: string) =>
    method === m && matches(resource, pattern)

  if (write("POST", "command")) return arrCommand(service, body)
  if (write("PUT", `${media}/:id`))
    return flag(query, "movefiles", false) ? ADMIN : WRITE
  if (service === "sonarr" && write("PUT", "episode/:id")) return WRITE
  if (service === "sonarr" && write("PUT", "episode/monitor")) return WRITE
  if (write("POST", "queue/grab/:id")) return WRITE
  if (write("DELETE", "queue/:id"))
    return flag(query, "removefromclient", true)
      ? deletion(`${service}_delete_queue_item`)
      : WRITE
  if (write("POST", "history/failed/:id")) return WRITE
  if (write("DELETE", "blocklist/:id")) return WRITE
  if (write("POST", "release")) return WRITE
  if (
    method === "DELETE" &&
    (resource[0] === "episodefile" || resource[0] === "moviefile")
  )
    return deletion(
      service === "sonarr"
        ? "sonarr_delete_episode_file"
        : "radarr_delete_movie_file",
    )
  return ADMIN
}

function arrCommand(service: "sonarr" | "radarr", body: unknown): Route {
  const name =
    typeof body === "object" &&
    body !== null &&
    "name" in body &&
    typeof body.name === "string"
      ? body.name.toLowerCase().replace(/command$/, "")
      : undefined
  if (name === undefined) return refused("a command body needs a name")
  if (service === "sonarr" && SONARR_SEARCHES.has(name))
    return refused("use sonarr_search, which enforces episode scope.")
  return ARR_COMMANDS[service].has(name) ? WRITE : ADMIN
}

const SAB_KEYS = new Set([
  "mode",
  "name",
  "value",
  "value2",
  "limit",
  "start",
  "search",
  "cat",
  "nzo_ids",
  "failed_only",
])

const SAB_READ_MODES = new Set([
  "version",
  "warnings",
  "server_stats",
  "get_cats",
])

/** SABnzbd's API is GET-only; the mode, not the method, decides. */
export function sabRoute(path: string): Route {
  const parsed = parsePath(path)
  if (!parsed || parsed.segments.join("/") !== "api")
    return refused("SABnzbd paths are /api?mode=...")
  const keys = parsed.pairs.map(([key]) => key)
  if (
    keys.some((key) => !SAB_KEYS.has(key)) ||
    new Set(keys).size !== keys.length
  )
    return refused(
      `SABnzbd query keys are limited to ${[...SAB_KEYS].join(", ")}, each once`,
    )
  const get = (key: string) =>
    parsed.pairs.find(([candidate]) => candidate === key)?.[1]
  const mode = get("mode")
  const name = get("name")
  const job = get("value")
  // Without a job id, pause/resume/delete act on the whole downloader.
  const hasJob = job !== undefined && job !== "" && job !== "all"

  if ((mode === "queue" || mode === "history") && name === undefined)
    return READ
  if (mode !== undefined && SAB_READ_MODES.has(mode) && name === undefined)
    return READ
  if ((mode === "queue" || mode === "history") && name === "delete")
    return deletion("sabnzbd_delete_job")
  if (!hasJob) return ADMIN
  if (mode === "retry" && name === undefined) return WRITE
  if (mode === "queue" && (name === "pause" || name === "resume")) return WRITE
  if (mode === "queue" && name === "priority" && get("value2") !== undefined)
    return WRITE
  if (
    mode === "change_cat" &&
    name === undefined &&
    get("value2") !== undefined
  )
    return WRITE
  return ADMIN
}

const JELLYFIN_READ_DENIED = new Set([
  "auth",
  "startup",
  "environment",
  "plugins",
  "packages",
  "repositories",
  "devices",
  "system",
])

const JELLYFIN_READ_ALLOWED = new Set(["system/info", "system/info/public"])

export function jellyfinRoute(method: Method, path: string): Route {
  const parsed = parsePath(path)
  if (!parsed) return refused("malformed Jellyfin path")
  const segments = parsed.segments

  if (method === "GET") {
    if (JELLYFIN_READ_ALLOWED.has(segments.join("/"))) return READ
    return JELLYFIN_READ_DENIED.has(segments[0] ?? "") ? ADMIN : READ
  }
  if (method === "POST" && matches(segments, "items/:guid/refresh"))
    return WRITE
  if (method === "POST" && matches(segments, "items/remotesearch/apply/:guid"))
    return WRITE
  // Remote metadata lookups are POSTs that change nothing.
  if (
    method === "POST" &&
    segments.length === 3 &&
    segments[0] === "items" &&
    segments[1] === "remotesearch" &&
    segments[2] !== "apply"
  )
    return READ
  return ADMIN
}

export function seerrRoute(method: Method, path: string): Route {
  const parsed = parsePath(path)
  if (!parsed || parsed.segments[0] !== "api" || parsed.segments[1] !== "v1")
    return refused("paths start with /api/v1/")
  const resource = parsed.segments.slice(2)
  const head = resource[0] ?? ""

  if (method !== "GET" && (head === "issue" || head === "issuecomment"))
    return refused(
      "Seerr comments and issue status are owned by blitzcrank; use finish_issue.",
    )
  if (method === "GET")
    return head === "settings" || head === "auth" ? ADMIN : READ
  if (method === "POST" && matches(resource, "request")) return WRITE
  if (method === "POST" && matches(resource, "request/:id/retry")) return WRITE
  return ADMIN
}
