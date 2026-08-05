import { StringEnum } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

export const AUTOMATION_REPORT_TOOL = "submit_automation_report"

export type AutomationStatus = "ok" | "warnung" | "fehler"

export interface SubmittedAutomationReport {
  status: AutomationStatus
  body: string
}

export interface AutomationReportCapture {
  submissions: SubmittedAutomationReport[]
}

export interface ParsedAutomationReport extends SubmittedAutomationReport {
  empty: boolean
  malformed: boolean
}

const INVALID_REPORT_BODY =
  "Kein gültiger strukturierter Automationsbericht wurde übermittelt."

/** Accept only one submission made as the sole call in the final tool batch. */
export function parseAutomationReport(
  capture: AutomationReportCapture,
  finalToolNames: string[],
): ParsedAutomationReport {
  const submitted =
    capture.submissions.length === 1 &&
    finalToolNames.length === 1 &&
    finalToolNames[0] === AUTOMATION_REPORT_TOOL
      ? capture.submissions[0]
      : undefined
  if (!submitted) {
    return {
      status: "fehler",
      body: INVALID_REPORT_BODY,
      empty: false,
      malformed: true,
    }
  }
  const body = submitted.body.trim()
  return {
    status: submitted.status,
    body,
    empty: body === "",
    malformed: false,
  }
}

/**
 * Automation-only structured final output. `terminate` makes the validated
 * tool arguments the final result without paying for, or parsing, a follow-up
 * free-text assistant message.
 */
export function buildAutomationReportTool(
  capture: AutomationReportCapture,
): ToolDefinition {
  return defineTool({
    name: AUTOMATION_REPORT_TOOL,
    label: "Submit automation report",
    description:
      "Submit the final structured automation result. Call this exactly once as the final action after every required read, mutation, and verification. The call ends the run.",
    parameters: Type.Object({
      status: StringEnum(["ok", "warnung", "fehler"] as const, {
        description: "Overall outcome of the completed automation run",
      }),
      body: Type.String({
        description:
          "Human-readable operations note in the requested language, or an empty string when there are no actions or blockers to report",
      }),
    }),
    async execute(_toolCallId, params) {
      capture.submissions.push({ status: params.status, body: params.body })
      return {
        content: [
          {
            type: "text" as const,
            text: "Structured automation report submitted.",
          },
        ],
        details: { status: params.status, body: params.body },
        terminate: true,
      }
    },
  })
}
