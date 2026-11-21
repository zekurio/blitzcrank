import type { MatineeConfig } from "../../config.ts"
import { defineReads } from "../../tools/reads.ts"
import type { ServerTool } from "../../tools/tool.ts"
import { defineWrites } from "../../tools/writes.ts"
import { matineeCatalogReads, matineeReads } from "./reads.ts"
import { matineeActions, matineeRequestActions } from "./writes.ts"

/**
 * The admin account diagnoses and repairs. Only the request account reads
 * the catalog and asks for titles, so a request gets that account's group
 * policy and quota, never an admin's. Without its token no tool that
 * requests a title exists.
 */
export function buildMatineeTools(cfg: MatineeConfig): ServerTool[] {
  const service = { name: "matinee", label: "Matinee (media server)" }
  const admin = { url: cfg.url, token: cfg.apiKey }
  const requester =
    cfg.requestApiKey === undefined
      ? undefined
      : { url: cfg.url, token: cfg.requestApiKey }
  return [
    ...defineReads(service, matineeReads(admin)),
    ...defineWrites(service, matineeActions(admin)),
    ...(requester
      ? [
          ...defineReads(service, matineeCatalogReads(requester)),
          ...defineWrites(service, matineeRequestActions(requester)),
        ]
      : []),
  ]
}
