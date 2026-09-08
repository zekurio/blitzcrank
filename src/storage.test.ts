import assert from "node:assert/strict"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { Effect } from "effect"

import {
  AutomationDefinitionError,
  loadAutomationsEffect,
} from "./automations/definitions.ts"
import { CaseStore, emptyCase } from "./casefile.ts"
import { StorageError } from "./storage.ts"
import { RunContext } from "./tools/context.ts"

test("native case storage preserves pause failures, atomic writes, and evidence durability", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-storage-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new CaseStore(dir)
  assert.equal(await Effect.runPromise(store.isPausedEffect("7")), false)
  await Effect.runPromise(store.pauseEffect("7"))
  assert.equal(await Effect.runPromise(store.isPausedEffect("7")), true)
  await Effect.runPromise(store.resumeEffect("7"))
  assert.equal(await Effect.runPromise(store.isPausedEffect("7")), false)
  await mkdir(path.join(dir, "7.paused"))
  await assert.rejects(
    Effect.runPromise(store.isPausedEffect("7")),
    (error) => error instanceof StorageError && error.code === "EISDIR",
  )

  const file = emptyCase("7")
  file.sessionFile = "/session/7.jsonl"
  file.spend.deletes = 3
  file.summary.facts = ["line one\nline two"]
  const pending = store.saveEffect(file)
  assert.equal((await readdir(dir)).includes("7.json"), false)
  await Effect.runPromise(pending)
  assert.equal((await readdir(dir)).includes("7.json.tmp"), false)
  const restored = await Effect.runPromise(store.loadEffect("7"))
  assert.equal(restored.sessionFile, file.sessionFile)
  assert.equal(restored.spend.deletes, 3)
  assert.deepEqual(restored.summary.facts, ["line one line two"])

  const context = new RunContext()
  context.recordRead("sonarr", "/series/9", '{"id":9}')
  context.recordIdentity("anvil", 17)
  context.recordPath("sonarr", "/media/show", "path")
  await Effect.runPromise(store.saveEvidenceEffect("7", context.snapshot))
  const resumed = new RunContext({
    prior: await Effect.runPromise(store.loadEvidenceEffect("7")),
  })
  assert.equal(resumed.sawValue("sonarr", 9), true)
  assert.equal(resumed.sawIdentity("anvil", 17), true)
  assert.equal(resumed.sawRecordedPath("/media/show"), false)
  await Effect.runPromise(store.forgetEvidenceEffect("7"))
  assert.equal(
    await Effect.runPromise(store.loadEvidenceEffect("7")),
    undefined,
  )
  assert.equal(
    (await Effect.runPromise(store.loadEffect("7"))).spend.deletes,
    3,
  )

  // A failed temporary write cannot replace the previous durable case.
  await mkdir(path.join(dir, "7.json.tmp"))
  await assert.rejects(
    Effect.runPromise(store.saveEffect(emptyCase("7"))),
    StorageError,
  )
  assert.equal(
    (await Effect.runPromise(store.loadEffect("7"))).spend.deletes,
    3,
  )
})

test("missing and corrupt memory fail safely while invalid file names remain typed failures", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-corrupt-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new CaseStore(dir)
  assert.equal((await Effect.runPromise(store.loadEffect("8"))).spend.runs, 0)
  assert.equal(
    await Effect.runPromise(store.loadEvidenceEffect("8")),
    undefined,
  )
  for (const body of ["{broken", "null"]) {
    await writeFile(path.join(dir, "8.json"), body)
    await writeFile(path.join(dir, "8.evidence.json"), body)
    assert.equal((await Effect.runPromise(store.loadEffect("8"))).spend.runs, 0)
    assert.equal(
      await Effect.runPromise(store.loadEvidenceEffect("8")),
      undefined,
    )
  }
  await assert.rejects(
    Effect.runPromise(store.loadEffect("../escape")),
    StorageError,
  )
  await assert.rejects(
    Effect.runPromise(
      store.saveEvidenceEffect("../escape", new RunContext().snapshot),
    ),
    StorageError,
  )
  assert.equal(await readFile(path.join(dir, "8.json"), "utf8"), "null")
})

test("automation loading keeps missing directories optional and invalid definitions fatal", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-definitions-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.deepEqual(
    await Effect.runPromise(loadAutomationsEffect(path.join(dir, "missing"))),
    [],
  )
  await writeFile(
    path.join(dir, "check.md"),
    "---\nname: check\nschedule: '0 * * * *'\nmutation_tools: [anvil_retry_job]\n---\nCheck jobs.",
  )
  assert.deepEqual(
    (await Effect.runPromise(loadAutomationsEffect(dir)))[0]?.mutationTools,
    ["anvil_retry_job"],
  )
  await writeFile(
    path.join(dir, "check.md"),
    "---\nname: check\nschedule: '0 * * * *'\nmutation_tools: [anvil_retry_job, anvil_retry_job]\n---\nCheck jobs.",
  )
  await assert.rejects(
    Effect.runPromise(loadAutomationsEffect(dir)),
    (error) =>
      error instanceof AutomationDefinitionError &&
      error.message.includes("duplicate"),
  )
})
