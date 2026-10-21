import type { ServiceConfig } from "../../config.ts"
import { defineReads } from "../../tools/reads.ts"
import type { ServerTool } from "../../tools/tool.ts"
import { defineWrites } from "../../tools/writes.ts"
import { jellyfinReads } from "./reads.ts"
import { jellyfinActions } from "./writes.ts"

export function buildJellyfinTools(cfg: ServiceConfig): ServerTool[] {
  const service = { name: "jellyfin", label: "Jellyfin (library)" }
  return [
    ...defineReads(service, jellyfinReads(cfg)),
    ...defineWrites(service, jellyfinActions(cfg)),
  ]
}
