import type {
  AutomationReport,
  AutomationStatus,
} from "../automations/runner.js"

const STATUS_EMOJI: Record<AutomationStatus, string> = {
  ok: "🟢",
  warnung: "🟡",
  fehler: "🔴",
}

/** Discord rejects messages over 2000 characters; stay clear of that limit. */
const MAX_MESSAGE = 1900
const TRUNCATED = "\n… (truncated)"
const INTERNAL_STATUS = /^[ \t]*STATUS:[^\r\n]*\r?$/gim
const INTERNAL_MARKER =
  /^[ \t]*MANUAL_INTERVENTION_REQUIRED(?:[ \t]+[^\r\n]*)?\r?$/gm

/**
 * Report bodies are model output, so the host caps their length here and the
 * client suppresses mentions globally: a release title containing `@everyone`
 * must not be able to ping anyone.
 */
export function formatAutomationReport(report: AutomationReport): string {
  const header =
    `${STATUS_EMOJI[report.status]} **${report.status}** · ` +
    `reads ${report.reads} · mutations ${report.mutations} · ` +
    `deletes ${report.deletes} · ` +
    `tokens ${report.tokens}` +
    (report.malformed ? " · ⚠️ invalid report format" : "")
  const cleanedBody = publicReportBody(report.body)
  const body =
    report.empty || cleanedBody === "" ? "_nothing to report_" : cleanedBody
  const message = `${header}\n${body}`
  if (message.length <= MAX_MESSAGE) return message
  // The suffix is inside the budget, so MAX_MESSAGE bounds what we return.
  // Dropping a trailing lone surrogate keeps a split emoji from rendering as
  // a replacement character.
  const cut = message.slice(0, MAX_MESSAGE - TRUNCATED.length)
  return `${cut.replace(/[\uD800-\uDBFF]$/, "")}${TRUNCATED}`
}

/** Keep transcript-only breadcrumbs out of the human report and its budget. */
function publicReportBody(body: string): string {
  return body
    .replace(INTERNAL_STATUS, "")
    .replace(INTERNAL_MARKER, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
