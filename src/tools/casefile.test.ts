import assert from "node:assert/strict"
import test from "node:test"

import { Value } from "typebox/value"

import { emptyCase, MAX_ENTRIES, MAX_ENTRY_CHARS } from "../casefile.ts"
import { buildCaseFileTool } from "./casefile.ts"

test("case file entries beyond the stored caps fail validation instead of being cut", () => {
  const schema = buildCaseFileTool(emptyCase("20")).parameters
  const longest = "x".repeat(MAX_ENTRY_CHARS)

  assert.equal(Value.Check(schema, { facts: [longest] }), true)
  assert.equal(Value.Check(schema, { facts: [`${longest}x`] }), false)
  assert.equal(
    Value.Check(schema, { facts: [], hypothesis: `${longest}x` }),
    false,
  )
  assert.equal(
    Value.Check(schema, {
      facts: [],
      openQuestions: Array.from({ length: MAX_ENTRIES + 1 }, () => "open"),
    }),
    false,
  )
})
