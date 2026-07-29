import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { modelAnchor, usageAnchor } from "./session.js"

describe("comment footer", () => {
  test("the status line carries the model identity only", () => {
    assert.equal(
      modelAnchor("openai-codex/gpt-5.2-codex:high"),
      "[blitzcrank w/ gpt-5.2-codex:high]",
    )
  })

  test("defaults the thinking level when the spec omits it", () => {
    assert.equal(
      modelAnchor("anthropic/claude-sonnet-4-5"),
      "[blitzcrank w/ claude-sonnet-4-5:medium]",
    )
  })

  test("the final comment reports the issue total, not one run", () => {
    // Each run replaces the previous comment, so a per-run number would make a
    // four-run issue look as cheap as its last run.
    assert.equal(
      usageAnchor("openai-codex/gpt-5.2-codex:high", 132_400),
      "[blitzcrank w/ gpt-5.2-codex:high · 132.4k tokens]",
    )
  })

  test("scales the token count for readability", () => {
    const anchor = (tokens: number) =>
      usageAnchor("anthropic/claude-sonnet-4-5:medium", tokens)
    assert.match(anchor(842), /· 842 tokens\]$/)
    assert.match(anchor(48_200), /· 48.2k tokens\]$/)
    assert.match(anchor(3_900_000), /· 3.90M tokens\]$/)
  })

  test("keeps the marker the loop guard matches", () => {
    assert.ok(
      usageAnchor("anthropic/claude-sonnet-4-5", 1).startsWith(
        "[blitzcrank w/",
      ),
    )
  })
})
