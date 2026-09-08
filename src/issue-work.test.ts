import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { parseDirectives } from "./agent/directives.ts"
import type { IssueRunner, RunOutcome } from "./agent/runner.ts"
import { CaseStore } from "./casefile.ts"
import { IssueWork } from "./issue-work.ts"

test("stop pauses an issue and cancels active and queued work", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-stop-"))
  const cases = new CaseStore(dir)
  let runs = 0
  let started: (() => void) | undefined
  const active = new Promise<void>((resolve) => {
    started = resolve
  })
  const retracted: number[] = []
  const runner: Pick<IssueRunner, "notifyQueued" | "retractStatus" | "run"> = {
    async notifyQueued() {
      return { id: 42 }
    },
    async retractStatus(_issueId, status) {
      if (status.id !== undefined) retracted.push(status.id)
      status.id = undefined
    },
    async run(_event, _status, signal): Promise<RunOutcome> {
      runs += 1
      started?.()
      assert(signal)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        })
      })
      throw new Error("unreachable")
    },
  }
  const work = new IssueWork(runner, cases)
  const event = {
    kind: "webhook" as const,
    issueId: "12",
    payload: { notification_type: "ISSUE_COMMENT" as const },
  }

  try {
    assert.equal(await work.enqueue(event), "queued")
    await active
    assert.equal(await work.enqueue(event), "queued")

    await work.stop("12")
    await waitForDrain(work)

    assert.equal(runs, 1)
    assert.deepEqual(retracted, [42])
    assert.equal(await cases.isPaused("12"), true)
    assert.equal(await work.enqueue(event), "paused")

    await work.resume("12")
    assert.equal(await cases.isPaused("12"), false)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
})

async function waitForDrain(work: IssueWork): Promise<void> {
  while (work.queue.size > 0) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

test("pause survives restart and concurrent resume follows stop", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-pause-"))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const cases = new CaseStore(dir)
  const runner = {
    async notifyQueued() {
      return { id: undefined }
    },
    async retractStatus() {},
    async run(): Promise<RunOutcome> {
      throw new Error("unexpected run")
    },
  }
  const work = new IssueWork(runner, cases)
  await work.stop("12")
  assert.equal(await new CaseStore(dir).isPaused("12"), true)
  await Promise.all([work.stop("12"), work.resume("12")])
  assert.equal(await cases.isPaused("12"), false)
})

test("stop preserves active writes and resume does not revive old work", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-revisit-"))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const cases = new CaseStore(dir)
  let release = () => {}
  const finishing = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = () => {}
  const active = new Promise<void>((resolve) => {
    started = resolve
  })
  const ran: string[] = []
  const work = new IssueWork(
    {
      async notifyQueued() {
        return { id: undefined }
      },
      async retractStatus() {},
      async run(event): Promise<RunOutcome> {
        ran.push(event.issueId)
        const casefile = await cases.load(event.issueId)
        if (ran.length === 1) {
          started()
          await finishing
          casefile.summary.facts = ["Verified change before stop"]
          casefile.revisit = {
            dueAt: new Date(Date.now() + 60_000).toISOString(),
            reason: "Check completion",
            mediaScope: "tv",
            chain: 1,
            delayMs: 60_000,
          }
          await cases.save(casefile)
        }
        return {
          issueId: event.issueId,
          casefile,
          directives: parseDirectives(""),
        }
      },
    },
    cases,
  )
  const event = {
    kind: "webhook" as const,
    issueId: "12",
    payload: { notification_type: "ISSUE_COMMENT" as const },
  }
  await work.enqueue(event)
  await active
  await work.enqueue(event)
  work.armRevisit("12", 60_000, "Check completion", "tv")
  await work.stop("12")
  assert.equal(work.revisits.pending, 0)
  await work.resume("12")
  await work.enqueue({ ...event, issueId: "13" })
  release()
  await waitForDrain(work)
  assert.deepEqual(ran, ["12", "13"])
  const saved = await cases.load("12")
  assert.deepEqual(saved.summary.facts, ["Verified change before stop"])
  assert.equal(saved.revisit, undefined)
  assert.equal(work.revisits.pending, 0)
  await work.enqueue(event)
  await waitForDrain(work)
  assert.deepEqual(ran, ["12", "13", "12"])
})

test("stop wins while a queued run waits for its pause check", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-start-"))
  t.after(() => rm(dir, { force: true, recursive: true }))
  let checked = () => {}
  const checking = new Promise<void>((resolve) => {
    checked = resolve
  })
  let release = () => {}
  const reading = new Promise<void>((resolve) => {
    release = resolve
  })
  class DelayedCaseStore extends CaseStore {
    reads = 0
    override async isPaused(issueId: string): Promise<boolean> {
      this.reads += 1
      if (this.reads !== 2) return super.isPaused(issueId)
      checked()
      await reading
      return false
    }
  }
  const cases = new DelayedCaseStore(dir)
  let runs = 0
  const work = new IssueWork(
    {
      async notifyQueued() {
        return { id: undefined }
      },
      async retractStatus() {},
      async run(): Promise<RunOutcome> {
        runs += 1
        throw new Error("stopped work must not start")
      },
    },
    cases,
  )
  await work.enqueue({
    kind: "webhook",
    issueId: "12",
    payload: { notification_type: "ISSUE_COMMENT" },
  })
  await checking
  await work.stop("12")
  await work.resume("12")
  release()
  await waitForDrain(work)
  assert.equal(runs, 0)
})
