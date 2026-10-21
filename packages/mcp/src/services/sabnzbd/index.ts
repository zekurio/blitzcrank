import type { ServiceConfig } from "../../config.ts"
import { defineReads } from "../../tools/reads.ts"
import type { ServerTool } from "../../tools/tool.ts"
import { defineWrites } from "../../tools/writes.ts"
import { sabnzbdReads } from "./reads.ts"
import { sabnzbdActions } from "./writes.ts"

export function buildSabnzbdTools(cfg: ServiceConfig): ServerTool[] {
  const service = { name: "sabnzbd", label: "SABnzbd (downloads)" }
  return [
    ...defineReads(service, sabnzbdReads(cfg)),
    ...defineWrites(service, sabnzbdActions(cfg)),
  ]
}
