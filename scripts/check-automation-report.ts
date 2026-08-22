import assert from "node:assert/strict"

import {
  AUTOMATION_REPORT_TOOL,
  buildAutomationReportTool,
  parseAutomationReport,
} from "../src/automations/report.ts"

const accepted = parseAutomationReport(
  { submissions: [{ status: "ok", body: "  Fertig.  " }] },
  [AUTOMATION_REPORT_TOOL],
)
assert.deepEqual(accepted, {
  status: "ok",
  body: "Fertig.",
  empty: false,
  malformed: false,
})

const empty = parseAutomationReport(
  { submissions: [{ status: "ok", body: "  " }] },
  [AUTOMATION_REPORT_TOOL],
)
assert.equal(empty.empty, true)
assert.equal(empty.malformed, false)

for (const malformed of [
  parseAutomationReport({ submissions: [] }, []),
  parseAutomationReport(
    {
      submissions: [
        { status: "ok", body: "" },
        { status: "ok", body: "" },
      ],
    },
    [AUTOMATION_REPORT_TOOL, AUTOMATION_REPORT_TOOL],
  ),
  parseAutomationReport({ submissions: [{ status: "ok", body: "" }] }, [
    "sonarr_request",
    AUTOMATION_REPORT_TOOL,
  ]),
]) {
  assert.equal(malformed.status, "fehler")
  assert.equal(malformed.empty, false)
  assert.equal(malformed.malformed, true)
}

const capture = { submissions: [] }
const tool = buildAutomationReportTool(capture)
const result = await tool.execute(
  "report-check",
  { status: "warnung", body: "Prüfen." },
  undefined,
  undefined,
  {} as never,
)
assert.equal(result.terminate, true)
assert.deepEqual(capture.submissions, [{ status: "warnung", body: "Prüfen." }])

console.log("structured automation report contract is valid")
