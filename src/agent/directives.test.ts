import assert from "node:assert/strict"
import test from "node:test"

import { parseDirectives, parseGoDuration } from "./directives.ts"

test("plain and outer-fenced directives preserve the existing valid form", () => {
  const text =
    "resolve_issue: NO\nrevisit_in: 2h30m\nrevisit_reason: Check import\n\nStill waiting."
  const expected = {
    resolve: false,
    revisitInMs: 9_000_000,
    revisitReason: "Check import",
    comment: "Still waiting.",
    malformed: false,
  }
  assert.deepEqual(parseDirectives(text), expected)
  assert.deepEqual(parseDirectives(`\`\`\`text\n${text}\n\`\`\``), expected)
  assert.deepEqual(parseDirectives(`\`\`\`\n${text}\n\`\`\``), expected)
  assert.deepEqual(parseDirectives("RESOLVE_ISSUE: YES\n\nFixed."), {
    resolve: true,
    revisitInMs: undefined,
    revisitReason: undefined,
    comment: "Fixed.",
    malformed: false,
  })
})

test("header-only responses need no public comment", () => {
  for (const suffix of ["", "\n\n", "\r\n\r\n"]) {
    assert.deepEqual(parseDirectives(`RESOLVE_ISSUE: no${suffix}`), {
      resolve: false,
      revisitInMs: undefined,
      revisitReason: undefined,
      comment: "",
      malformed: false,
    })
  }
  // Resolution plus revisit and either optional-header order remain accepted.
  assert.deepEqual(
    parseDirectives(
      "RESOLVE_ISSUE: yes\nREVISIT_REASON: Check import\nREVISIT_IN: 45m",
    ),
    {
      resolve: true,
      revisitInMs: 2_700_000,
      revisitReason: "Check import",
      comment: "",
      malformed: false,
    },
  )
})

test("supported durations are finite and valid revisits clamp to 10m..48h", () => {
  for (const [duration, ms] of [
    ["0s", 600_000],
    ["90s", 600_000],
    ["10m", 600_000],
    ["2h30m15s", 9_015_000],
    ["48h", 172_800_000],
    ["100h", 172_800_000],
  ] as const) {
    const parsed = parseDirectives(
      `RESOLVE_ISSUE: no\nREVISIT_IN: ${duration}\nREVISIT_REASON: Verify`,
    )
    assert.equal(parsed.malformed, false)
    assert.equal(parsed.revisitInMs, ms)
  }
  assert.equal(parseGoDuration(" 2h30m15s "), 9_015_000)
  for (const duration of [
    "",
    "1d",
    "1.5h",
    "-1m",
    "1m2h",
    "Infinity",
    `${"9".repeat(400)}h`,
    `${"9".repeat(305)}h`,
  ]) {
    assert.equal(parseGoDuration(duration), undefined, duration)
  }
})

test("invalid headers fail closed even after valid actions have been parsed", () => {
  const invalid = [
    "",
    "Public text only",
    "REVISIT_IN: 45m\nRESOLVE_ISSUE: no",
    "RESOLVE_ISSUE: maybe",
    "RESOLVE_ISSUE: yes extra",
    "RESOLVE_ISSUE: yes\nRESOLVE_ISSUE: no",
    "RESOLVE_ISSUE: no\nREVISIT_IN: 45m",
    "RESOLVE_ISSUE: yes\nREVISIT_REASON: Check import",
    "RESOLVE_ISSUE: yes\nREVISIT_IN: nonsense\nREVISIT_REASON: Verify",
    "RESOLVE_ISSUE: no\nREVISIT_IN: 45m\nREVISIT_REASON:   ",
    "RESOLVE_ISSUE: yes\nREVISIT_IN: 45m\nREVISIT_IN: 1h\nREVISIT_REASON: Verify",
    "RESOLVE_ISSUE: yes\nREVISIT_IN: 45m\nREVISIT_REASON: Verify\nREVISIT_REASON: Again",
    "RESOLVE_ISSUE: yes\nREVISIT_IN: 45m\nREVISIT_REASON: Verify\nUNKNOWN: value",
    "RESOLVE_ISSUE: yes\nREVISIT_IN 45m\nREVISIT_REASON: Verify",
    "RESOLVE_ISSUE: yes\nPublic comment without separator",
    "RESOLVE_ISSUE: yes\nREVISIT_IN: 45m\nREVISIT_REASON: Verify\nMissing separator",
    "RESOLVE_ISSUE: yes\n\nRESOLVE_ISSUE: no\n\nNeeds a check.",
    "RESOLVE_ISSUE: yes\n\nREVISIT_IN: nonsense\n\nMust not publish.",
    "RESOLVE_ISSUE: yes\n\nPublic text.\n  revisit_reason: Verify",
    "RESOLVE_ISSUE: yes\n\nREVISIT_IN 45m",
    "RESOLVE_ISSUE: yes\n\n```\nRESOLVE_ISSUE: no\n```",
    `RESOLVE_ISSUE: yes\nREVISIT_IN: ${"9".repeat(400)}h\nREVISIT_REASON: Verify`,
  ]
  const expected = {
    resolve: false,
    revisitInMs: undefined,
    revisitReason: undefined,
    comment: "",
    malformed: true,
  }
  for (const text of invalid) {
    assert.deepEqual(parseDirectives(text), expected, text)
    assert.deepEqual(
      parseDirectives(`\`\`\`text\n${text}\n\nMust not publish.\n\`\`\``),
      expected,
      text,
    )
  }
  parseDirectives(
    "RESOLVE_ISSUE: yes\nREVISIT_IN: 45m\nREVISIT_REASON: Verify\n\nValid",
  )
  assert.deepEqual(parseDirectives("Not a directive"), expected)
})
