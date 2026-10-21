import type { ServiceConfig } from "../../config.ts"
import { defineReads } from "../../tools/reads.ts"
import type { ServerTool } from "../../tools/tool.ts"
import { defineWrites } from "../../tools/writes.ts"
import { seerrReads } from "./reads.ts"
import { seerrActions } from "./writes.ts"

export function buildSeerrTools(cfg: ServiceConfig): ServerTool[] {
  const service = { name: "seerr", label: "Seerr (requests and issues)" }
  return [
    ...defineReads(service, seerrReads(cfg)),
    ...defineWrites(service, seerrActions(cfg)),
  ]
}
