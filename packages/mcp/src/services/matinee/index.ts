import type { ServiceConfig } from "../../config.ts"
import { defineReads } from "../../tools/reads.ts"
import type { ServerTool } from "../../tools/tool.ts"
import { defineWrites } from "../../tools/writes.ts"
import { matineeCatalogReads, matineeReads } from "./reads.ts"
import { matineeActions, matineeRequestActions } from "./writes.ts"

/**
 * One Matinee account does everything: it diagnoses, repairs, and asks for
 * titles. What its token may do is set in Matinee, where it can retry a
 * failed send but approve nothing, so a request it makes waits for approval
 * under its group's quota.
 */
export function buildMatineeTools(cfg: ServiceConfig): ServerTool[] {
  const service = { name: "matinee", label: "Matinee (media server)" }
  const account = { url: cfg.url, token: cfg.apiKey }
  return [
    ...defineReads(service, matineeReads(account)),
    ...defineReads(service, matineeCatalogReads(account)),
    ...defineWrites(service, matineeActions(account)),
    ...defineWrites(service, matineeRequestActions(account)),
  ]
}
