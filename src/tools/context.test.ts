import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { RunContext } from "./context.js"

describe("RunContext evidence gates", () => {
  test("an id seen in a read of the same service passes", () => {
    const ctx = new RunContext()
    ctx.recordRead("sonarr", "/api/v3/series", '[{"id":42,"title":"YAIBA"}]')
    ctx.requireEvidence("sonarr", 42, "series id")
  })

  test("an id seen only in another service does not pass", () => {
    const ctx = new RunContext()
    ctx.recordRead("sonarr", "/api/v3/series", '[{"id":42}]')
    assert.throws(
      () => ctx.requireEvidence("radarr", 42, "movie id"),
      /did not appear in any radarr read/,
    )
  })

  test("ids match on word boundaries, not substrings", () => {
    const ctx = new RunContext()
    ctx.recordRead("sonarr", "/api/v3/series", '[{"id":421}]')
    assert.equal(ctx.sawValue("sonarr", 42), false)
    assert.equal(ctx.sawValue("sonarr", 421), true)
  })

  test("paths match exactly, punctuation included", () => {
    const ctx = new RunContext()
    ctx.recordRead("sonarr", "/api/v3/manualimport", '["/mnt/tv/a b.mkv"]')
    assert.equal(ctx.sawValue("sonarr", "/mnt/tv/a b.mkv"), true)
    assert.equal(ctx.sawValue("sonarr", "/mnt/tv/other.mkv"), false)
  })
})

describe("RunContext budgets", () => {
  test("mutations are capped per run", () => {
    const ctx = new RunContext({ maxMutations: 2, maxDeletes: 2 })
    ctx.noteMutation("mutate")
    ctx.noteMutation("mutate")
    assert.throws(() => ctx.noteMutation("mutate"), /at most 2 mutations/)
    assert.deepEqual(ctx.counts, { mutations: 2, deletes: 0 })
  })

  test("deletions have their own, stricter cap and also count as mutations", () => {
    const ctx = new RunContext({ maxMutations: 5, maxDeletes: 1 })
    ctx.noteMutation("delete")
    assert.throws(() => ctx.noteMutation("delete"), /at most 1 deletions/)
    ctx.noteMutation("mutate")
    assert.deepEqual(ctx.counts, { mutations: 2, deletes: 1 })
  })
})

describe("RunContext probe evidence", () => {
  test("an exact probed file is recognized", () => {
    const ctx = new RunContext()
    ctx.recordProbe("/mnt/tv/YAIBA/S01E01.mkv")
    assert.equal(ctx.sawProbe("/mnt/tv/YAIBA/S01E01.mkv"), true)
    assert.equal(ctx.sawProbe("/mnt/tv/YAIBA/S01E02.mkv"), false)
  })

  test("probing a directory covers the files below it", () => {
    const ctx = new RunContext()
    ctx.recordProbe("/mnt/downloads/complete/YAIBA.S01")
    assert.equal(
      ctx.sawProbe("/mnt/downloads/complete/YAIBA.S01/e01.mkv"),
      true,
    )
    assert.equal(
      ctx.sawProbe("/mnt/downloads/complete/YAIBA.S01-other/e01.mkv"),
      false,
    )
  })

  test("nothing is probed by default", () => {
    assert.equal(new RunContext().sawProbe("/mnt/tv/a.mkv"), false)
  })

  test("a probe target must have appeared in a service read", () => {
    const ctx = new RunContext()
    ctx.recordRead(
      "sonarr",
      "/api/v3/episodefile?seriesId=1",
      '[{"path":"/mnt/tv/YAIBA/S01E01.mkv"}]',
    )
    assert.equal(ctx.sawPathInAnyRead("/mnt/tv/YAIBA/S01E01.mkv"), true)
    assert.equal(ctx.sawPathInAnyRead("/mnt/tv/Other/S01E01.mkv"), false)
  })

  test("a file inside a directory a service returned is allowed", () => {
    const ctx = new RunContext()
    ctx.recordRead(
      "sabnzbd",
      "/api?mode=history",
      '{"storage":"/mnt/downloads/complete/YAIBA.S01E01"}',
    )
    assert.equal(
      ctx.sawPathInAnyRead("/mnt/downloads/complete/YAIBA.S01E01/f.mkv"),
      true,
    )
    assert.equal(
      ctx.sawPathInAnyRead("/mnt/downloads/complete/OTHER/f.mkv"),
      false,
    )
  })

  test("a bare root is never enough on its own", () => {
    const ctx = new RunContext()
    ctx.recordRead("sonarr", "/api/v3/series", '[{"path":"/"}]')
    assert.equal(ctx.sawPathInAnyRead("/etc/hosts"), false)
  })
})
