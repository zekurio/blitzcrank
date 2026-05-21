import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

async function callBlitzcrankTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
  const baseURL = process.env.BLITZCRANK_TOOL_BASE_URL;
  const secret = process.env.BLITZCRANK_TOOL_SECRET;
  if (!baseURL || !secret) throw new Error("Blitzcrank tool gateway is not configured");
  const response = await fetch(`${baseURL.replace(/\/$/, "")}/internal/pi/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-blitzcrank-tool-secret": secret },
    body: JSON.stringify({ arguments: args }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(String(payload.error || `Blitzcrank tool ${name} failed with HTTP ${response.status}`));
  }
  return payload.result;
}

function toolResult(result: unknown) {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text" as const, text }], details: result ?? {} };
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

function registerServiceTool(pi: ExtensionAPI, service: string, description: string) {
  pi.registerTool({
    name: `${service}_request`,
    label: `${service} API request`,
    description,
    parameters: serviceRequestSchema,
    async execute(_toolCallId, params, signal) {
      return toolResult(await callBlitzcrankTool(`${service}_request`, params as Record<string, unknown>, signal));
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerServiceTool(pi, "seerr", "Call the configured Seerr API. Use relative /api/v1 paths. Do not post comments or resolve issues; Blitzcrank owns that lifecycle.");
  registerServiceTool(pi, "jellyfin", "Call the configured Jellyfin API. Use relative Jellyfin API paths such as /Items?... or /Users/...");
  registerServiceTool(pi, "sonarr", "Call the configured Sonarr API. Use relative /api/v3 paths for series, history, queue, commands, manual import, etc.");
  registerServiceTool(pi, "radarr", "Call the configured Radarr API. Use relative /api/v3 paths for movies, history, queue, commands, manual import, etc.");
  registerServiceTool(pi, "sabnzbd", "Call the configured SABnzbd API. Use /api?mode=... paths; Blitzcrank injects apikey and output=json.");

  pi.registerTool({
    name: "thread_history_search",
    label: "Search Blitzcrank thread history",
    description: "Search prior Blitzcrank issue and automation traces for similar investigations or fixes. Treat results as clues and validate current state before acting.",
    parameters: Type.Object({
      query: Type.String({ description: "Search terms such as a title, error, queue/import symptom, or prior fix" }),
      source: Type.Optional(Type.String({ description: "Optional source filter: all, issues, automations, or legacy discord" })),
      limit: Type.Optional(Type.Number({ description: "Maximum threads to return, from 1 to 10" })),
      exclude_thread_id: Type.Optional(Type.String({ description: "Current thread or issue id to omit" })),
    }),
    async execute(_toolCallId, params, signal) {
      return toolResult(await callBlitzcrankTool("thread_history_search", params as Record<string, unknown>, signal));
    },
  });

  pi.on("tool_call", (event) => {
    if (!event.toolName.endsWith("_request")) return;
    const input = event.input as { method?: string; path?: string; purpose?: string; safety_level?: string; safety_reason?: string };
    const method = (input.method || "GET").toUpperCase();
    const path = input.path || "";
    if (!input.purpose?.trim()) return { block: true, reason: "purpose is required" };
    if (!path.startsWith("/")) return { block: true, reason: "path must be service-relative and start with /" };
    if (/^https?:\/\//i.test(path) || /apikey|api_key|token/i.test(path)) return { block: true, reason: "path must not contain full URLs or credentials" };
    if (event.toolName === "seerr_request" && (/\/comment\b/i.test(path) || /\/resolved\b/i.test(path))) {
      return { block: true, reason: "Seerr comments and issue resolution are owned by Blitzcrank" };
    }
    if (method !== "GET" && (input.safety_level !== "narrow_mutation" || !input.safety_reason?.trim())) {
      return { block: true, reason: "non-GET service requests require safety_level=narrow_mutation and safety_reason" };
    }
  });
}
