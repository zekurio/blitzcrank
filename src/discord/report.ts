import type {
  AutomationReport,
  AutomationStatus,
} from "../automations/runner.js"

const STATUS_EMOJI: Record<AutomationStatus, string> = {
  ok: "🟢",
  warnung: "🟡",
  fehler: "🔴",
}

/** Discord hard-caps messages at 2000 characters; leave room for the header. */
const MAX_MESSAGE = 1900

/**
 * Report bodies are model output, so the host caps their length here and the
 * client suppresses mentions globally: a release title containing `@everyone`
 * must not be able to ping anyone.
 */
export function formatAutomationReport(report: AutomationReport): string {
  const header =
    `${STATUS_EMOJI[report.status]} **${report.status}** · ` +
    `mutations ${report.mutations} · deletes ${report.deletes} · ` +
    `tokens ${report.tokens}` +
    (report.malformed ? " · ⚠️ output ignored the STATUS protocol" : "")
  const body = report.empty ? "_nothing to report_" : report.body
  const message = `${header}\n${body}`
  if (message.length <= MAX_MESSAGE) return message
  return `${message.slice(0, MAX_MESSAGE)}\n… (truncated)`
}
