import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import type { SeerrClient } from "../services/seerr.js";
import { buildAnvilTools } from "./anvil.js";
import { buildRadarrTools, buildSonarrTools } from "./arr.js";
import type { RunContext } from "./context.js";
import {
  buildJellyfinTools,
  buildProgressTool,
  buildSabnzbdTools,
  buildSeerrTools,
} from "./services.js";

export interface ToolDeps {
  config: Config;
  ctx: RunContext;
  seerr: SeerrClient;
  issueId: string | number;
  commentHeader: string;
}

/**
 * Assemble the per-run tool set. Raw `*_request` tools are GET-only;
 * every state change is a dedicated typed tool with evidence gates,
 * budgets, and built-in verification (see tools/common.ts).
 */
export function buildTools({ config, ctx, seerr, issueId, commentHeader }: ToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    buildProgressTool(seerr, issueId, commentHeader, config.language),
    ...buildSeerrTools(config.seerr, seerr, ctx),
  ];
  if (config.sonarr) tools.push(...buildSonarrTools(config.sonarr, ctx));
  if (config.radarr) tools.push(...buildRadarrTools(config.radarr, ctx));
  if (config.jellyfin) tools.push(...buildJellyfinTools(config.jellyfin, ctx));
  if (config.sabnzbd) tools.push(...buildSabnzbdTools(config.sabnzbd, ctx));
  if (config.anvil) tools.push(...buildAnvilTools(config.anvil));
  return tools;
}
