import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { RunUsageTracker, turnStopReason } from "./session.js"

const usage = (tokens: number, cost: number) => ({
  totalTokens: tokens,
  cost: { total: cost },
})

describe("RunUsageTracker", () => {
  test("sums usage as messages complete", () => {
    const tracker = new RunUsageTracker(undefined, 0)
    tracker.add(usage(100, 0.25))
    tracker.add(usage(50, 0.1))
    assert.deepEqual(tracker.usage, { totalTokens: 150, cost: 0.35 })
  })

  test("never trips without a ceiling", () => {
    const tracker = new RunUsageTracker(undefined, 0)
    assert.equal(tracker.add(usage(1, 100)), false)
  })

  test("trips once the issue total reaches the ceiling", () => {
    const tracker = new RunUsageTracker(5, 4.2)
    assert.equal(tracker.add(usage(10, 0.5)), false)
    assert.equal(tracker.add(usage(10, 0.5)), true)
    assert.equal(tracker.total, 5.2)
  })

  test("counts spend from earlier runs on the same issue", () => {
    const alreadySpent = new RunUsageTracker(5, 4.99)
    assert.equal(alreadySpent.add(usage(1, 0.02)), true)
  })

  test("trips only once, so abort is requested a single time", () => {
    const tracker = new RunUsageTracker(1, 0)
    assert.equal(tracker.add(usage(1, 2)), true)
    assert.equal(tracker.add(usage(1, 2)), false)
    assert.equal(tracker.add(usage(1, 2)), false)
  })

  test("keeps accumulating after the ceiling, for honest accounting", () => {
    const tracker = new RunUsageTracker(1, 0)
    tracker.add(usage(10, 2))
    tracker.add(usage(10, 1))
    assert.equal(tracker.usage.cost, 3)
    assert.equal(tracker.usage.totalTokens, 20)
  })
})

describe("turnStopReason", () => {
  test("a run that finished on its own is not ceiling-stopped", () => {
    // The ceiling was crossed by the final message: abort was requested, but
    // the loop had already produced the answer.
    assert.equal(turnStopReason(true, "stop"), undefined)
  })

  test("a genuinely interrupted run is ceiling-stopped", () => {
    assert.equal(turnStopReason(true, "aborted"), "cost_ceiling")
  })

  test("no abort request means no ceiling stop", () => {
    assert.equal(turnStopReason(false, "aborted"), undefined)
    assert.equal(turnStopReason(false, "stop"), undefined)
  })
})
