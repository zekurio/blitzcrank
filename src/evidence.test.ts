import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { EvidenceStore } from "./evidence.ts"
import { RunContext } from "./tools/context.ts"

test("evidence snapshots resume without per-run paths or counters", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-evidence-test-"))
  try {
    const store = new EvidenceStore(dir, "test")
    const first = new RunContext()
    first.recordRead("sonarr", "/api/v3/series/7", '{"id":7}')
    first.recordIdentity("anvil", 19)
    first.recordPath("sonarr", "/downloads/show", "outputPath")
    first.recordProbe("/downloads/show/episode.mkv")
    first.noteMutation("delete")
    await store.save("123", first.snapshot)

    const resumed = new RunContext({ prior: await store.load("123") })

    assert.equal(resumed.sawValue("sonarr", 7), true)
    assert.equal(resumed.sawIdentity("anvil", 19), true)
    assert.equal(resumed.sawProbe("/downloads/show/episode.mkv"), true)
    assert.equal(resumed.sawRecordedPath("/downloads/show"), false)
    assert.deepEqual(resumed.counts, { mutations: 0, deletes: 0 })

    await store.forget("123")
    assert.equal(await store.load("123"), undefined)
    await assert.rejects(
      store.save("../escape", first.snapshot),
      /refusing to use/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
