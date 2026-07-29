import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { emptyCase, type PendingRevisit } from "./casefile.js"
import { planRevisit, revisitDelay } from "./revisits.js"

const NOW = Date.parse("2026-07-29T00:00:00.000Z")
const MINUTES = 60_000

const base = {
  requestedMs: 30 * MINUTES,
  reason: "replacement import must finish",
  mediaScope: "tv" as const,
  previous: undefined as PendingRevisit | undefined,
  isRevisitRun: false,
  producedNews: true,
  maxChain: 3,
  now: NOW,
}

const armed = (chain: number, delayMs: number): PendingRevisit => ({
  dueAt: new Date(NOW).toISOString(),
  reason: "still importing",
  mediaScope: "tv",
  chain,
  delayMs,
})

describe("planRevisit", () => {
  test("arms nothing when the agent asked for nothing", () => {
    const plan = planRevisit({ ...base, requestedMs: undefined })
    assert.equal(plan.revisit, undefined)
    assert.equal(plan.refused, undefined)
  })

  test("arms nothing when the reason is missing", () => {
    assert.equal(planRevisit({ ...base, reason: undefined }).revisit, undefined)
  })

  test("a webhook run starts a fresh chain", () => {
    const plan = planRevisit({ ...base, previous: armed(3, 30 * MINUTES) })
    assert.equal(plan.revisit?.chain, 1)
    assert.equal(plan.revisit?.delayMs, 30 * MINUTES)
    assert.equal(plan.revisit?.dueAt, "2026-07-29T00:30:00.000Z")
  })

  test("a revisit run continues the chain", () => {
    const plan = planRevisit({
      ...base,
      isRevisitRun: true,
      previous: armed(1, 30 * MINUTES),
    })
    assert.equal(plan.revisit?.chain, 2)
  })

  test("the chain is capped and the refusal is explained", () => {
    const plan = planRevisit({
      ...base,
      isRevisitRun: true,
      previous: armed(3, 30 * MINUTES),
    })
    assert.equal(plan.revisit, undefined)
    assert.match(String(plan.refused), /chain limit 3 reached/)
  })

  test("a follow-up with no news at least doubles the delay", () => {
    const plan = planRevisit({
      ...base,
      isRevisitRun: true,
      producedNews: false,
      previous: armed(1, 30 * MINUTES),
    })
    assert.equal(plan.revisit?.delayMs, 60 * MINUTES)
    assert.match(String(plan.refused), /backed off to 60m/)
  })

  test("a longer request wins over the backoff floor", () => {
    const plan = planRevisit({
      ...base,
      requestedMs: 4 * 60 * MINUTES,
      isRevisitRun: true,
      producedNews: false,
      previous: armed(1, 30 * MINUTES),
    })
    assert.equal(plan.revisit?.delayMs, 4 * 60 * MINUTES)
    assert.equal(plan.refused, undefined)
  })

  test("the backoff cannot grow past what a timer can hold", () => {
    const plan = planRevisit({
      ...base,
      isRevisitRun: true,
      producedNews: false,
      previous: armed(1, 40 * 60 * MINUTES),
    })
    assert.equal(plan.revisit?.delayMs, 48 * 60 * MINUTES)
  })

  test("news keeps the delay the agent asked for", () => {
    const plan = planRevisit({
      ...base,
      isRevisitRun: true,
      producedNews: true,
      previous: armed(1, 30 * MINUTES),
    })
    assert.equal(plan.revisit?.delayMs, 30 * MINUTES)
  })
})

describe("revisitDelay", () => {
  test("is undefined without a pending revisit", () => {
    assert.equal(revisitDelay(emptyCase("9"), NOW), undefined)
  })

  test("keeps the remaining time after a restart", () => {
    const file = emptyCase("9")
    file.revisit = armed(1, 30 * MINUTES)
    file.revisit.dueAt = new Date(NOW + 20 * MINUTES).toISOString()
    assert.equal(revisitDelay(file, NOW), 20 * MINUTES)
  })

  test("an overdue revisit runs shortly after boot, not immediately", () => {
    const file = emptyCase("9")
    file.revisit = armed(1, 30 * MINUTES)
    file.revisit.dueAt = new Date(NOW - 5 * 60 * MINUTES).toISOString()
    assert.equal(revisitDelay(file, NOW), 30_000)
  })

  test("a far-future due date is clamped to the maximum", () => {
    const file = emptyCase("9")
    file.revisit = armed(1, 30 * MINUTES)
    file.revisit.dueAt = new Date(NOW + 3.2e12).toISOString()
    assert.equal(revisitDelay(file, NOW), 48 * 60 * MINUTES)
  })

  test("an unparsable due date is dropped", () => {
    const file = emptyCase("9")
    file.revisit = { ...armed(1, 30 * MINUTES), dueAt: "soon" }
    assert.equal(revisitDelay(file, NOW), undefined)
  })
})
