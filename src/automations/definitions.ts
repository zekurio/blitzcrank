import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export interface AutomationDefinition {
  name: string;
  description: string;
  schedule: string;
  enabled: boolean;
  capabilities: string[];
  mutationBudget: number;
  deletionBudget: number;
  body: string;
  filePath: string;
}

/**
 * Deterministic capability -> mutation tool mapping. An automation's
 * frontmatter declares capabilities; only the mapped tools (plus the always-on
 * read tools) are registered for its runs. Unknown capabilities fail loading.
 */
export const CAPABILITY_TOOLS: Record<string, string[]> = {
  "sonarr.manual_import": ["sonarr_manual_import"],
  "radarr.manual_import": ["radarr_manual_import"],
  "sonarr.queue_rejection_cleanup": ["sonarr_delete_queue_item"],
  "radarr.queue_rejection_cleanup": ["radarr_delete_queue_item"],
  "sonarr.search": ["sonarr_search"],
  "radarr.search": ["radarr_search"],
  "sonarr.refresh": ["sonarr_refresh_series"],
  "radarr.refresh": ["radarr_refresh_movie"],
  "sonarr.file_deletion": ["sonarr_delete_episode_file"],
  "radarr.file_deletion": ["radarr_delete_movie_file"],
  "sonarr.queue_grab": ["sonarr_grab_queue_item"],
  "radarr.queue_grab": ["radarr_grab_queue_item"],
  "sonarr.blocklist_cleanup": ["sonarr_remove_from_blocklist"],
  "radarr.blocklist_cleanup": ["radarr_remove_from_blocklist"],
  "sabnzbd.job_control": ["sabnzbd_retry_job", "sabnzbd_pause_job", "sabnzbd_resume_job"],
  "sabnzbd.job_deletion": ["sabnzbd_delete_job"],
  "jellyfin.refresh": ["jellyfin_refresh_item"],
  "seerr.request_creation": ["seerr_create_request"],
};

export function capabilityTools(capabilities: string[]): string[] {
  return capabilities.flatMap((capability) => {
    const tools = CAPABILITY_TOOLS[capability];
    if (!tools) {
      throw new Error(
        `unknown capability "${capability}"; known: ${Object.keys(CAPABILITY_TOOLS).join(", ")}`,
      );
    }
    return tools;
  });
}

function parseDefinition(filePath: string, raw: string): AutomationDefinition {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error(`${filePath}: missing YAML frontmatter`);
  const meta = parse(match[1]!) as Record<string, unknown>;
  const body = raw.slice(match[0].length).trim();

  const name = String(meta.name ?? "");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${filePath}: frontmatter name must be kebab-case, got "${name}"`);
  }
  if (name !== path.basename(filePath, ".md")) {
    throw new Error(`${filePath}: name "${name}" must match the filename`);
  }
  const schedule = String(meta.schedule ?? "");
  if (!schedule) throw new Error(`${filePath}: schedule is required`);
  if (!body) throw new Error(`${filePath}: automation body is empty`);

  const capabilities = Array.isArray(meta.capabilities) ? meta.capabilities.map(String) : [];
  capabilityTools(capabilities); // validate eagerly

  return {
    name,
    description: String(meta.description ?? ""),
    schedule,
    enabled: meta.enabled !== false,
    capabilities,
    mutationBudget: Number(meta.mutation_budget ?? 3),
    deletionBudget: Number(meta.deletion_budget ?? 0),
    body,
    filePath,
  };
}

export async function loadAutomations(dir: string): Promise<AutomationDefinition[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const definitions: AutomationDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    definitions.push(parseDefinition(filePath, await readFile(filePath, "utf8")));
  }
  const names = new Set<string>();
  for (const def of definitions) {
    if (names.has(def.name)) throw new Error(`duplicate automation name "${def.name}"`);
    names.add(def.name);
  }
  return definitions;
}
