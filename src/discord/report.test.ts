import assert from "node:assert/strict"
import { test } from "node:test"

import type { AutomationReport } from "../automations/runner.js"
import { formatAutomationReport } from "./report.js"

/** Discord's cap minus header room; mirrors MAX_MESSAGE in report.ts. */
const MAX_MESSAGE = 1900

function reportOf(overrides: Partial<AutomationReport>): AutomationReport {
  return {
    name: "library-sweep",
    status: "ok",
    body: "nothing broken",
    empty: false,
    malformed: false,
    mutations: 0,
    deletes: 0,
    tokens: 0,
    ...overrides,
  }
}

test("formats the header fields and the body", () => {
  const message = formatAutomationReport(
    reportOf({ mutations: 2, deletes: 1, tokens: 4321, body: "fixed two" }),
  )
  assert.equal(
    message,
    "🟢 **ok** · mutations 2 · deletes 1 · tokens 4321\nfixed two",
  )
})

test("uses one emoji per status", () => {
  assert.ok(formatAutomationReport(reportOf({ status: "ok" })).startsWith("🟢"))
  assert.ok(
    formatAutomationReport(reportOf({ status: "warnung" })).startsWith("🟡"),
  )
  assert.ok(
    formatAutomationReport(reportOf({ status: "fehler" })).startsWith("🔴"),
  )
})

test("replaces an empty report with a placeholder body", () => {
  const message = formatAutomationReport(reportOf({ body: "", empty: true }))
  assert.equal(
    message,
    "🟢 **ok** · mutations 0 · deletes 0 · tokens 0\n_nothing to report_",
  )
})

test("keeps the placeholder even when a body survived an empty run", () => {
  const message = formatAutomationReport(
    reportOf({ body: "leftover", empty: true }),
  )
  assert.ok(message.endsWith("_nothing to report_"))
})

test("marks output that ignored the STATUS protocol", () => {
  const message = formatAutomationReport(
    reportOf({ status: "fehler", malformed: true, body: "no status line" }),
  )
  assert.equal(
    message,
    "🔴 **fehler** · mutations 0 · deletes 0 · tokens 0 · " +
      "⚠️ output ignored the STATUS protocol\nno status line",
  )
})

test("keeps a message that lands exactly on the cap", () => {
  const headerLength = formatAutomationReport(reportOf({ body: "" })).length
  const body = "x".repeat(MAX_MESSAGE - headerLength)
  const message = formatAutomationReport(reportOf({ body }))
  assert.equal(message.length, MAX_MESSAGE)
  assert.ok(!message.includes("(truncated)"))
})

test("truncates an oversized body and says so", () => {
  const message = formatAutomationReport(reportOf({ body: "y".repeat(5000) }))
  assert.ok(message.startsWith("🟢 **ok** ·"))
  assert.ok(message.endsWith("\n… (truncated)"))
  assert.equal(message.length, MAX_MESSAGE)
})

test("never truncates in the middle of a surrogate pair", () => {
  // Land the cut on the emoji straddling the budget boundary.
  const message = formatAutomationReport(reportOf({ body: "🟢".repeat(2000) }))
  assert.ok(message.length <= MAX_MESSAGE)
  assert.ok(!message.includes("\uFFFD"))
  const kept = message.replace(/\n… \(truncated\)$/, "")
  assert.equal(Array.from(kept).at(-1), "🟢")
})
