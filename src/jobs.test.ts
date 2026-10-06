import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { Effect } from "effect"

import { BusyJobError, JobStore, UncertainActionError } from "./jobs.ts"
import { SerialQueue } from "./queue.ts"

test("journal commits admission, preserves order, and excludes a second owner", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "blitz-jobs-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "jobs.sqlite")
  const store = new JobStore(path)
  const first = store.create("issue", { issueId: 1 }, { id: "stable" })
  const second = store.create("automation", {}, { busyKey: "automation:a" })
  store.markRunning(first.id)
  assert.throws(() => new JobStore(path), /locked/)
  assert.equal(store.create("issue", {}, { id: "stable" }).id, first.id)
  assert.throws(
    () => store.create("automation", {}, { busyKey: "automation:a" }),
    BusyJobError,
  )
  store.close()
  const reopened = new JobStore(path)
  assert.deepEqual(
    reopened.pending().map((job) => job.id),
    [first.id, second.id],
  )
  reopened.markCompleted(second.id)
  reopened.create("automation", {}, { busyKey: "automation:a" })
  reopened.markCancelled(first.id)
  reopened.close()
})

test("unsafe intent fails closed on reopen and successful JSON results are cached", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "blitz-actions-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "jobs.sqlite")
  const store = new JobStore(path)
  const job = store.create("discord", {})
  await Effect.runPromise(
    store.actionEffect(job.id, "posted", Effect.succeed({ id: 42 })),
  )
  await assert.rejects(
    Effect.runPromise(
      store.actionEffect(
        job.id,
        "uncertain",
        Effect.fail(new Error("lost reply")),
      ),
    ),
  )
  store.close()
  const reopened = new JobStore(path)
  t.after(() => reopened.close())
  let calls = 0
  const effect = Effect.sync(() => {
    calls++
    return { id: 99 }
  })
  assert.deepEqual(
    await Effect.runPromise(reopened.actionEffect(job.id, "posted", effect)),
    { id: 42 },
  )
  await assert.rejects(
    Effect.runPromise(reopened.actionEffect(job.id, "uncertain", effect)),
    UncertainActionError,
  )
  assert.equal(calls, 0)
  assert.deepEqual(
    await Effect.runPromise(
      reopened.actionEffect(job.id, "uncertain", effect, { replaySafe: true }),
    ),
    { id: 99 },
  )
  assert.equal(calls, 1)
  assert.deepEqual(
    reopened.actions(job.id).map((action) => action.completed),
    [true, true],
  )
})

test("queue starts only admitted work; errors are terminal and never retried", async (t) => {
  const store = new JobStore()
  t.after(() => store.close())
  const queue = new SerialQueue()
  const job = store.create("issue", {})
  let calls = 0
  const task = () =>
    Effect.sync(() => {
      calls++
      assert.equal(store.get(job.id)?.status, "running")
      throw new Error("ordinary failure")
    })
  store.enqueue(queue, job, task)
  store.enqueue(queue, job, task)
  await Effect.runPromise(queue.drainEffect())
  assert.equal(calls, 1)
  assert.equal(store.get(job.id)?.status, "failed")
  assert.match(store.get(job.id)?.error ?? "", /ordinary failure/)
  store.enqueue(queue, job, task)
  await Effect.runPromise(queue.drainEffect())
  assert.equal(calls, 1)
})

test("process death releases ownership and preserves running work and action intents", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "blitz-crash-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "jobs.sqlite")
  const child = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `
      import { JobStore } from ${JSON.stringify(new URL("./jobs.ts", import.meta.url).href)}
      import { Effect } from "effect"
      const store = new JobStore(${JSON.stringify(path)})
      const job = store.create("issue", { issueId: 12 }, { id: "crashed" })
      store.markRunning(job.id)
      await Effect.runPromise(store.actionEffect(job.id, "delivery", Effect.fail("lost"))).catch(() => {})
      process.kill(process.pid, "SIGKILL")
    `,
  ])
  assert.equal(child.signal, "SIGKILL", child.stderr.toString())
  const jobs = new JobStore(path)
  t.after(() => jobs.close())
  assert.equal(jobs.pending("issue")[0]?.id, "crashed")
  assert.equal(jobs.get("crashed")?.status, "running")
  await assert.rejects(
    Effect.runPromise(jobs.actionEffect("crashed", "delivery", Effect.void)),
    UncertainActionError,
  )
})

test("cancellation skips waiting work and cannot be overwritten by active completion", async (t) => {
  const jobs = new JobStore()
  t.after(() => jobs.close())
  const queue = new SerialQueue()
  const active = jobs.create("issue", {})
  const waiting = jobs.create("issue", {})
  jobs.enqueue(queue, active, () => Effect.sleep("10 millis"))
  jobs.enqueue(queue, waiting, () =>
    Effect.die(new Error("cancelled task must not run")),
  )
  jobs.markCancelled(active.id)
  jobs.markCancelled(waiting.id)
  await Effect.runPromise(queue.drainEffect())
  assert.equal(jobs.get(active.id)?.status, "cancelled")
  assert.equal(jobs.get(waiting.id)?.status, "cancelled")
  jobs.markFailed(active.id, "late failure")
  assert.equal(jobs.get(active.id)?.status, "cancelled")
  await Effect.runPromise(jobs.actionEffect(active.id, "cleanup", Effect.void))
  assert.equal(jobs.actions(active.id)[0]?.completed, true)
})

test("cancel intent survives reopen and completion or failure until cleanup finishes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "blitz-cancelling-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, "jobs.sqlite")
  const first = new JobStore(file)
  const job = first.create("issue", {}, { busyKey: "issue:12" })
  first.markRunning(job.id)
  first.requestCancel(job.id)
  first.markCompleted(job.id)
  first.markFailed(job.id, "cleanup interrupted")
  first.close()
  const jobs = new JobStore(file)
  t.after(() => jobs.close())
  assert.equal(jobs.pending()[0]?.status, "cancelling")
  assert.match(jobs.get(job.id)?.error ?? "", /cleanup interrupted/)
  assert.throws(
    () => jobs.create("issue", {}, { busyKey: "issue:12" }),
    BusyJobError,
  )
  const queue = new SerialQueue()
  jobs.enqueue(queue, jobs.get(job.id)!, () => Effect.void)
  await Effect.runPromise(queue.drainEffect())
  assert.equal(jobs.get(job.id)?.status, "cancelling")
  jobs.markCancelled(job.id)
  jobs.markFailed(job.id, "late")
  jobs.requestCancel(job.id)
  assert.equal(jobs.get(job.id)?.status, "cancelled")
  assert.equal(jobs.pending().length, 0)
})
