import assert from "node:assert/strict"
import { test } from "node:test"

import { parseDirectives, parseGoDuration } from "./directives.js"

const MINUTE = 60 * 1000

test("parses Go-style durations", () => {
  assert.equal(parseGoDuration("45m"), 45 * MINUTE)
  assert.equal(parseGoDuration(" 2h30m "), 150 * MINUTE)
  assert.equal(parseGoDuration("90s"), 90 * 1000)
  assert.equal(parseGoDuration(""), undefined)
  assert.equal(parseGoDuration("1d"), undefined)
  assert.equal(parseGoDuration("30"), undefined)
  assert.equal(parseGoDuration("m30"), undefined)
})

test("parses a resolve directive and the public comment", () => {
  assert.deepEqual(parseDirectives("RESOLVE_ISSUE: yes\n\nFixed, enjoy."), {
    resolve: true,
    revisitInMs: undefined,
    revisitReason: undefined,
    comment: "Fixed, enjoy.",
    malformed: false,
  })
  assert.equal(
    parseDirectives("resolve_issue: NO\n\nstill broken").resolve,
    false,
  )
})

test("parses a revisit request with its reason", () => {
  assert.deepEqual(
    parseDirectives(
      "RESOLVE_ISSUE: no\nREVISIT_IN: 45m\nREVISIT_REASON: download running\n\nWait for it.",
    ),
    {
      resolve: false,
      revisitInMs: 45 * MINUTE,
      revisitReason: "download running",
      comment: "Wait for it.",
      malformed: false,
    },
  )
})

test("clamps revisit delays into the 10m-48h window", () => {
  const short = parseDirectives(
    "RESOLVE_ISSUE: no\nREVISIT_IN: 30s\nREVISIT_REASON: soon",
  )
  assert.equal(short.revisitInMs, 10 * MINUTE)
  const long = parseDirectives(
    "RESOLVE_ISSUE: no\nREVISIT_IN: 72h\nREVISIT_REASON: later",
  )
  assert.equal(long.revisitInMs, 48 * 60 * MINUTE)
})

test("drops a reason that has no revisit delay", () => {
  const parsed = parseDirectives(
    "RESOLVE_ISSUE: no\nREVISIT_REASON: orphaned\nREVISIT_IN: nonsense\n\nhi",
  )
  assert.equal(parsed.revisitInMs, undefined)
  assert.equal(parsed.revisitReason, undefined)
  assert.equal(parsed.comment, "hi")
})

test("keeps a revisit delay whose reason is missing", () => {
  const parsed = parseDirectives("RESOLVE_ISSUE: no\nREVISIT_IN: 1h\n\nhi")
  assert.equal(parsed.revisitInMs, 60 * MINUTE)
  assert.equal(parsed.revisitReason, undefined)
})

test("treats a response without the directive block as malformed", () => {
  assert.deepEqual(parseDirectives("Sorry, I could not fix this."), {
    resolve: false,
    revisitInMs: undefined,
    revisitReason: undefined,
    comment: "Sorry, I could not fix this.",
    malformed: true,
  })
  assert.ok(parseDirectives("").malformed)
  assert.ok(parseDirectives("RESOLVE_ISSUE: maybe\n\nhm").malformed)
  assert.ok(parseDirectives("intro\nRESOLVE_ISSUE: yes\n\nhm").malformed)
})

test("unfences a code-fenced response", () => {
  const parsed = parseDirectives(
    "```text\nRESOLVE_ISSUE: yes\n\nAll good now.\n```",
  )
  assert.equal(parsed.malformed, false)
  assert.equal(parsed.resolve, true)
  assert.equal(parsed.comment, "All good now.")
})

test("stops the directive block at an unknown line", () => {
  const parsed = parseDirectives(
    "RESOLVE_ISSUE: yes\nNOTES: internal\nREVISIT_IN: 1h\n\nvisible",
  )
  assert.equal(parsed.revisitInMs, undefined)
  assert.equal(parsed.comment, "NOTES: internal\nREVISIT_IN: 1h\n\nvisible")
})

test("allows an empty public comment", () => {
  assert.equal(parseDirectives("RESOLVE_ISSUE: yes\n").comment, "")
  assert.equal(parseDirectives("RESOLVE_ISSUE: yes\n\n  \n").comment, "")
})
