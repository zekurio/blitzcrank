import assert from "node:assert/strict"
import { test } from "node:test"

import { parseAutomationOutput } from "./runner.js"

test("treats blank output as a run with nothing to report", () => {
  assert.deepEqual(parseAutomationOutput("   \n\n  "), {
    status: "ok",
    body: "",
    empty: true,
    malformed: false,
  })
})

test("parses each status and the body below it", () => {
  assert.deepEqual(parseAutomationOutput("STATUS: ok\nall good"), {
    status: "ok",
    body: "all good",
    empty: false,
    malformed: false,
  })
  assert.equal(
    parseAutomationOutput("STATUS: warnung\nqueue stalled").status,
    "warnung",
  )
  assert.equal(
    parseAutomationOutput("STATUS: fehler\nsonarr down").status,
    "fehler",
  )
})

test("accepts the status line case-insensitively and lowercases it", () => {
  assert.equal(parseAutomationOutput("status: Warnung\nhm").status, "warnung")
  assert.equal(parseAutomationOutput("StAtUs:FEHLER\nhm").status, "fehler")
})

test("keeps a multi-line body and trims its edges", () => {
  assert.equal(
    parseAutomationOutput("STATUS: ok\n\nfirst\n\nsecond\n\n").body,
    "first\n\nsecond",
  )
})

test("flags a status line with no body as empty", () => {
  assert.deepEqual(parseAutomationOutput("STATUS: ok\n\n   "), {
    status: "ok",
    body: "",
    empty: true,
    malformed: false,
  })
})

test("treats output without a status line as a malformed failure", () => {
  assert.deepEqual(parseAutomationOutput("I checked everything, looks fine"), {
    status: "fehler",
    body: "I checked everything, looks fine",
    empty: false,
    malformed: true,
  })
})

test("requires the status line first and the status word to be known", () => {
  assert.ok(parseAutomationOutput("preamble\nSTATUS: ok\nbody").malformed)
  assert.ok(parseAutomationOutput("STATUS: green\nbody").malformed)
  assert.ok(parseAutomationOutput("STATUS: ok extra\nbody").malformed)
})
