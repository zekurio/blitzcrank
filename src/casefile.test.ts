import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"

import { CaseStore, clampEntries, emptyCase, renderCase } from "./casefile.js"

let dir: string

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "blitzcrank-cases-"))
})
after(() => rm(dir, { recursive: true, force: true }))

describe("clampEntries", () => {
  test("normalizes whitespace and drops empties", () => {
    assert.deepEqual(clampEntries(["  a\n  b ", "", "   "]), ["a b"])
  })

  test("caps entry count and length", () => {
    const values = Array.from({ length: 30 }, () => "x".repeat(500))
    const clamped = clampEntries(values)
    assert.equal(clamped.length, 12)
    assert.equal(clamped[0]?.length, 300)
  })

  test("ignores non-arrays and non-strings", () => {
    assert.deepEqual(clampEntries(undefined), [])
    assert.deepEqual(clampEntries([1, null, "ok"]), ["ok"])
  })
})

describe("renderCase", () => {
  test("is empty for a fresh issue", () => {
    assert.equal(renderCase(emptyCase("9")), undefined)
  })

  test("renders facts, ruled-out causes and recent runs", () => {
    const file = emptyCase("9")
    file.summary = {
      hypothesis: "German dub may not exist",
      facts: ["series 483; 24 files, all jpn single-stream (media_probe)"],
      ruledOut: ["lost during conversion"],
      openQuestions: ["is there a German release date"],
    }
    file.spend = { runs: 2, tokens: 1000, cost: 1.5 }
    file.runs = [
      {
        at: "2026-07-29T00:00:00.000Z",
        trigger: "webhook",
        mutations: 1,
        deletes: 0,
        tokens: 500,
        cost: 0.8,
        commented: true,
        resolved: false,
      },
    ]
    const rendered = renderCase(file) ?? ""
    assert.match(rendered, /Current hypothesis: German dub may not exist/)
    assert.match(rendered, /all jpn single-stream/)
    assert.match(rendered, /Ruled out:/)
    assert.match(rendered, /Previous runs \(2 total\)/)
    assert.match(rendered, /webhook: 1 mutation\(s\), commented/)
  })
})

describe("CaseStore", () => {
  test("an unknown issue loads as an empty case", async () => {
    const store = new CaseStore(dir)
    const file = await store.load("404")
    assert.equal(file.issueId, "404")
    assert.deepEqual(file.spend, { runs: 0, tokens: 0, cost: 0 })
    assert.equal(file.revisit, undefined)
  })

  test("round-trips spend, summary and the pending revisit", async () => {
    const store = new CaseStore(dir)
    const file = emptyCase("9")
    file.spend = { runs: 3, tokens: 2000, cost: 4.2 }
    file.summary.facts = ["24 files, all jpn"]
    file.revisit = {
      dueAt: "2026-07-29T02:00:00.000Z",
      reason: "replacement import",
      mediaScope: "tv",
      chain: 2,
      delayMs: 1_800_000,
    }
    await store.save(file)

    const loaded = await store.load("9")
    assert.equal(loaded.spend.cost, 4.2)
    assert.deepEqual(loaded.summary.facts, ["24 files, all jpn"])
    assert.equal(loaded.revisit?.chain, 2)
  })

  test("keeps only the most recent runs", async () => {
    const store = new CaseStore(dir)
    const file = emptyCase("10")
    file.runs = Array.from({ length: 20 }, (_, i) => ({
      at: `run-${i}`,
      trigger: "revisit" as const,
      mutations: 0,
      deletes: 0,
      tokens: 1,
      cost: 0.01,
      commented: false,
      resolved: false,
    }))
    await store.save(file)
    const loaded = await store.load("10")
    assert.equal(loaded.runs.length, 8)
    assert.equal(loaded.runs.at(-1)?.at, "run-19")
  })

  test("lists only issues with a pending revisit", async () => {
    const store = new CaseStore(dir)
    const quiet = emptyCase("11")
    await store.save(quiet)
    const pending = await store.pendingRevisits()
    assert.deepEqual(
      pending.map((file) => file.issueId),
      ["9"],
    )
  })

  test("refuses an issue id that is not a plain identifier", async () => {
    const store = new CaseStore(dir)
    await assert.rejects(
      () => store.load("../../etc/passwd"),
      /refusing to use/,
    )
  })

  test("a partially written case file does not survive as garbage", async () => {
    const store = new CaseStore(dir)
    await writeFile(path.join(dir, "12.json.tmp"), "{ broken", "utf8")
    const file = await store.load("12")
    assert.equal(file.spend.runs, 0)
  })
})
