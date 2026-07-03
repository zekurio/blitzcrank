import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

function env(name: string): string {
  return (process.env[name] || "").trim();
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function toolResult(result: unknown) {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text" as const, text }], details: result ?? {} };
}

function assertServicePath(path: string) {
  if (!path.startsWith("/")) throw new Error("path must be service-relative and start with /");
  if (/^https?:\/\//i.test(path) || /apikey|api_key|token/i.test(path)) {
    throw new Error("path must not contain full URLs or credentials");
  }
}

function assertMutationSafety(method: string, input: { safety_level?: string; safety_reason?: string }) {
  if (method === "GET") return;
  if (input.safety_level !== "narrow_mutation" || !input.safety_reason?.trim()) {
    throw new Error("non-GET service requests require safety_level=narrow_mutation and safety_reason");
  }
}

type MutationRule = { method: string; pattern: RegExp; commandNames?: string[] };

const MUTATION_ALLOWLIST: Record<string, MutationRule[]> = {
  sonarr: [
    { method: "POST", pattern: /^\/api\/v3\/command\/?$/i, commandNames: ["EpisodeSearch", "SeasonSearch", "SeriesSearch", "RefreshSeries", "ManualImport"] },
    { method: "POST", pattern: /^\/api\/v3\/queue\/grab\/\d+\/?$/i },
    { method: "DELETE", pattern: /^\/api\/v3\/queue\/\d+(\?.*)?$/i },
    { method: "DELETE", pattern: /^\/api\/v3\/blocklist\/\d+\/?$/i },
  ],
  radarr: [
    { method: "POST", pattern: /^\/api\/v3\/command\/?$/i, commandNames: ["MoviesSearch", "RefreshMovie", "ManualImport"] },
    { method: "POST", pattern: /^\/api\/v3\/queue\/grab\/\d+\/?$/i },
    { method: "DELETE", pattern: /^\/api\/v3\/queue\/\d+(\?.*)?$/i },
    { method: "DELETE", pattern: /^\/api\/v3\/blocklist\/\d+\/?$/i },
  ],
  jellyfin: [
    { method: "POST", pattern: /^\/Items\/[^/]+\/Refresh(\?.*)?$/i },
  ],
  seerr: [
    { method: "POST", pattern: /^\/api\/v1\/request\/?$/i },
  ],
  sabnzbd: [], // documented read-only (.pi/skills/sabnzbd/SKILL.md)
};

function assertMutationAllowed(service: string, method: string, path: string, body: unknown) {
  if (method === "GET") return;
  const rules = MUTATION_ALLOWLIST[service] ?? [];
  const rule = rules.find((r) => r.method === method && r.pattern.test(path));
  if (!rule) {
    throw new Error(`${method} ${path} is not in the ${service} mutation allowlist; this gateway only permits the narrow mutations documented in .pi/skills`);
  }
  if (rule.commandNames) {
    const name = typeof body === "object" && body !== null ? String((body as Record<string, unknown>).name ?? "") : "";
    if (!rule.commandNames.some((allowed) => allowed.toLowerCase() === name.toLowerCase())) {
      throw new Error(`${service} command "${name}" is not in the allowed command set: ${rule.commandNames.join(", ")}`);
    }
  }
}

async function jsonRequest(url: string, init: RequestInit, signal: AbortSignal) {
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  let payload: unknown = text;
  if (text) {
    try { payload = JSON.parse(text); } catch { /* keep text */ }
  } else {
    payload = null;
  }
  if (!response.ok) {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 1000)}`);
  }
  return payload;
}

const serviceRequestSchema = Type.Object({
  purpose: Type.String({ description: "Why this API request is needed and what evidence or action it should produce" }),
  method: Type.Optional(Type.Union([
    Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("PATCH"), Type.Literal("DELETE"),
  ], { description: "HTTP method; defaults to GET" })),
  path: Type.String({ description: "Service-relative path only, starting with /. Never include a full URL or API key." }),
  body: Type.Optional(Type.Any({ description: "JSON body for POST/PUT/PATCH requests" })),
  safety_level: Type.Optional(Type.String({ description: "Use narrow_mutation for non-GET requests" })),
  safety_reason: Type.Optional(Type.String({ description: "Required for non-GET requests; explain the exact target and why it is safe" })),
});

const anvilStatusSchema = Type.Object({
  purpose: Type.String({ description: "Why the Anvil systemd service state is needed for this diagnosis or automation run" }),
});

type ServiceRequest = {
  purpose: string;
  method?: string;
  path: string;
  body?: unknown;
  safety_level?: string;
  safety_reason?: string;
};

async function callService(service: string, input: ServiceRequest, signal: AbortSignal) {
  const method = (input.method || "GET").toUpperCase();
  const path = input.path;
  if (!input.purpose?.trim()) throw new Error("purpose is required");
  assertServicePath(path);
  assertMutationSafety(method, input);
  if (service === "seerr" && (/\/comment\b/i.test(path) || /\/resolved\b/i.test(path))) {
    throw new Error("Seerr comments and issue resolution are owned by Blitzcrank");
  }
  assertMutationAllowed(service, method, path, input.body);

  const headers: Record<string, string> = { accept: "application/json" };
  let url: string;
  let body: BodyInit | undefined;

  if (input.body !== undefined && method !== "GET") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(input.body);
  }

  switch (service) {
    case "seerr":
      url = trimSlash(requireEnv("SEERR_BASE_URL")) + path;
      headers["X-Api-Key"] = requireEnv("SEERR_API_KEY");
      if (env("SEERR_BOT_USER_ID")) headers["X-Api-User"] = env("SEERR_BOT_USER_ID");
      break;
    case "jellyfin":
      url = trimSlash(requireEnv("JELLYFIN_BASE_URL")) + path;
      headers["X-Emby-Token"] = requireEnv("JELLYFIN_API_KEY");
      break;
    case "sonarr":
      url = trimSlash(requireEnv("SONARR_BASE_URL")) + path;
      headers["X-Api-Key"] = requireEnv("SONARR_API_KEY");
      break;
    case "radarr":
      url = trimSlash(requireEnv("RADARR_BASE_URL")) + path;
      headers["X-Api-Key"] = requireEnv("RADARR_API_KEY");
      break;
    case "sabnzbd": {
      if (!path.startsWith("/api")) throw new Error("SABnzbd path must start with /api");
      const parsed = new URL(trimSlash(requireEnv("SABNZBD_BASE_URL")) + path);
      parsed.searchParams.set("apikey", requireEnv("SABNZBD_API_KEY"));
      parsed.searchParams.set("output", "json");
      url = parsed.toString();
      break;
    }
    default:
      throw new Error(`unknown service ${service}`);
  }

  return jsonRequest(url, { method, headers, body }, signal);
}

function registerServiceTool(pi: ExtensionAPI, service: string, description: string) {
  pi.registerTool({
    name: `${service}_request`,
    label: `${service} API request`,
    description,
    parameters: serviceRequestSchema,
    async execute(_toolCallId, params, signal) {
      return toolResult(await callService(service, params as ServiceRequest, signal));
    },
  });
}

function anvilSystemdUnit(): string {
  let unit = env("ANVIL_SYSTEMD_UNIT") || "anvil.service";
  if (!unit.includes(".")) unit += ".service";
  if (!/^[A-Za-z0-9_.@:-]+\.service$/.test(unit)) {
    throw new Error("ANVIL_SYSTEMD_UNIT must name a single .service unit");
  }
  return unit;
}

function execFileText(file: string, args: string[], signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { signal, timeout: 10_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim();
        reject(new Error(detail || error.message));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function parseSystemctlShow(text: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    properties[line.slice(0, index)] = line.slice(index + 1);
  }
  return properties;
}

function waitRecommendedFromSystemd(properties: Record<string, string>, jobs: string[]): boolean {
  const activeState = (properties.ActiveState || "").toLowerCase();
  const subState = (properties.SubState || "").toLowerCase();
  if (jobs.length > 0) return true;
  if (activeState === "activating" || activeState === "reloading") return true;
  return activeState === "active" && subState !== "exited" && subState !== "dead";
}

async function anvilStatus(input: { purpose?: string }, signal: AbortSignal) {
  if (!input.purpose?.trim()) throw new Error("purpose is required");
  const unit = anvilSystemdUnit();
  const properties = [
    "Id",
    "Names",
    "Description",
    "LoadState",
    "ActiveState",
    "SubState",
    "Result",
    "MainPID",
    "ExecMainPID",
    "ExecMainCode",
    "ExecMainStatus",
    "NRestarts",
    "ActiveEnterTimestamp",
    "InactiveEnterTimestamp",
    "ExecMainStartTimestamp",
    "ExecMainExitTimestamp",
  ].join(",");
  let show: { stdout: string; stderr: string };
  try {
    show = await execFileText("systemctl", ["show", unit, "--no-page", `--property=${properties}`], signal);
  } catch (error) {
    return {
      unit,
      available: false,
      wait_recommended: false,
      active_state: "",
      sub_state: "",
      result: "",
      main_pid: "",
      jobs: [],
      error: error instanceof Error ? error.message : String(error),
      properties: {},
    };
  }
  const parsed = parseSystemctlShow(show.stdout);
  let jobs: string[] = [];
  try {
    const listed = await execFileText("systemctl", ["list-jobs", "--no-legend", "--plain", unit], signal);
    jobs = listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    jobs = [];
  }
  return {
    unit,
    available: Boolean(parsed.LoadState) && parsed.LoadState !== "not-found",
    wait_recommended: waitRecommendedFromSystemd(parsed, jobs),
    active_state: parsed.ActiveState || "",
    sub_state: parsed.SubState || "",
    result: parsed.Result || "",
    main_pid: parsed.MainPID || "",
    jobs,
    properties: parsed,
  };
}

async function collectFiles(root: string, out: string[], maxFiles = 1000): Promise<void> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await collectFiles(path, out, maxFiles);
    else if (entry.isFile() && /\.(jsonl|md|txt|log)$/i.test(entry.name)) out.push(path);
  }
}

function scoreText(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function snippet(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const term of terms) {
    idx = lower.indexOf(term);
    if (idx >= 0) break;
  }
  if (idx < 0) idx = 0;
  const start = Math.max(0, idx - 240);
  const end = Math.min(text.length, idx + 760);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

async function threadHistorySearch(params: { query: string; source?: string; limit?: number; exclude_thread_id?: string }) {
  const query = (params.query || "").trim();
  if (!query) throw new Error("query is required");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Math.max(1, Math.min(10, Number(params.limit || 5)));
  const roots = [env("PI_CODING_AGENT_SESSION_DIR")].filter(Boolean);
  const files: string[] = [];
  for (const root of roots) await collectFiles(root, files);

  const exclude = (params.exclude_thread_id || "").toLowerCase();
  const source = (params.source || "all").toLowerCase();
  const results: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const lowerFile = file.toLowerCase();
    if (exclude && lowerFile.includes(exclude)) continue;
    if (source !== "all" && source && !lowerFile.includes(source.replace(/s$/, ""))) continue;
    let text: string;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    const score = scoreText(text, terms);
    if (score <= 0) continue;
    let info: { mtime?: Date; size?: number } = {};
    try { const s = await stat(file); info = { mtime: s.mtime, size: s.size }; } catch { /* ignore */ }
    results.push({ path: file, score, modified: info.mtime?.toISOString(), size: info.size, snippet: snippet(text, terms) });
  }
  results.sort((a, b) => Number(b.score) - Number(a.score));
  return { query, results: results.slice(0, limit) };
}

async function kagiSearch(params: { query: string; limit?: number; include_markdown?: boolean }, signal: AbortSignal) {
  const query = (params.query || "").trim();
  if (!query) throw new Error("query is required");
  const limit = Math.max(1, Math.min(10, Number(params.limit || 5)));
  const body = { q: query, limit, ...(params.include_markdown ? { extract: true } : {}) };
  const headers = { authorization: `Bearer ${requireEnv("KAGI_API_KEY")}`, "content-type": "application/json", accept: "application/json" };
  return await jsonRequest("https://kagi.com/api/v1/search", { method: "POST", headers, body: JSON.stringify(body) }, signal);
}

function assertPublicHTTPURL(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  // The fetch itself is performed remotely by Kagi's extract API, not from this
  // process, so a hostname that merely resolves to a private IP is out of reach
  // here; rejecting private/reserved literals is the appropriate depth for this check.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost =
    host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
    /^127\./.test(host) || host === "::1" || host === "0.0.0.0" ||
    /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host);
  if (privateHost) throw new Error("local/private URLs are not allowed");
  return url.toString();
}

async function kagiFetch(params: { url: string }, signal: AbortSignal) {
  const url = assertPublicHTTPURL((params.url || "").trim());
  const headers = { authorization: `Bearer ${requireEnv("KAGI_API_KEY")}`, "content-type": "application/json", accept: "application/json" };
  return await jsonRequest("https://kagi.com/api/v1/extract", { method: "POST", headers, body: JSON.stringify({ urls: [url] }) }, signal);
}

export default function (pi: ExtensionAPI) {
  registerServiceTool(pi, "seerr", "Call the configured Seerr API. Use relative /api/v1 paths. Do not post comments or resolve issues; Blitzcrank owns that lifecycle.");
  registerServiceTool(pi, "jellyfin", "Call the configured Jellyfin API. Use relative Jellyfin API paths such as /Items?... or /Users/...");
  registerServiceTool(pi, "sonarr", "Call the configured Sonarr API. Use relative /api/v3 paths for series, history, queue, commands, manual import, etc.");
  registerServiceTool(pi, "radarr", "Call the configured Radarr API. Use relative /api/v3 paths for movies, history, queue, commands, manual import, etc.");
  registerServiceTool(pi, "sabnzbd", "Call the configured SABnzbd API. Use /api?mode=... paths; the tool injects apikey and output=json.");

  pi.registerTool({
    name: "anvil_status",
    label: "Anvil systemd status",
    description: "Read the configured Anvil systemd service state. This is read-only and cannot start, stop, restart, or mutate services.",
    parameters: anvilStatusSchema,
    async execute(_toolCallId, params, signal) {
      return toolResult(await anvilStatus(params as { purpose?: string }, signal));
    },
  });

  pi.registerTool({
    name: "thread_history_search",
    label: "Search Blitzcrank thread history",
    description: "Search prior Pi session history for similar investigations or fixes. Treat results as clues and validate current live state before acting.",
    parameters: Type.Object({
      query: Type.String({ description: "Search terms such as a title, error, queue/import symptom, or prior fix" }),
      source: Type.Optional(Type.String({ description: "Optional source filter: all, issues, or automations" })),
      limit: Type.Optional(Type.Number({ description: "Maximum threads to return, from 1 to 10" })),
      exclude_thread_id: Type.Optional(Type.String({ description: "Current thread or issue id to omit" })),
    }),
    async execute(_toolCallId, params) {
      return toolResult(await threadHistorySearch(params as { query: string; source?: string; limit?: number; exclude_thread_id?: string }));
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description: "Search the public web using Kagi. Use for current public information and cite URLs when results influence the answer.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Maximum results, 1 to 10" })),
      include_markdown: Type.Optional(Type.Boolean({ description: "Ask Kagi to include markdown extraction for top results when supported" })),
    }),
    async execute(_toolCallId, params, signal) {
      return toolResult(await kagiSearch(params as { query: string; limit?: number; include_markdown?: boolean }, signal));
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Fetch web page",
    description: "Extract markdown from a public HTTP(S) URL using Kagi Extract.",
    parameters: Type.Object({
      url: Type.String({ description: "Public http(s) URL to extract" }),
    }),
    async execute(_toolCallId, params, signal) {
      return toolResult(await kagiFetch(params as { url: string }, signal));
    },
  });
}
