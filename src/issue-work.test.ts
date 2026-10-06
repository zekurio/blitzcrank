import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { Deferred, Effect } from "effect"

import { parseDirectives } from "./agent/directives.ts"
import { sdkPromise } from "./agent/effect.ts"
import type { IssueRunner, RunOutcome } from "./agent/runner.ts"
import { CaseStore } from "./casefile.ts"
import { IssueWork } from "./issue-work.ts"
import { JobStore } from "./jobs.ts"
import { HttpRequestError } from "./services/http.ts"

for (const boundary of ["queued-notice", "active", "resumed"] as const) {
  test(`crash during cancellation at ${boundary} recovers cleanup without model work`, async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "blitz-cancel-crash-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const file = path.join(dir, "jobs.sqlite")
    const caseDir = path.join(dir, "cases")
    const child = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
        import { Effect } from "effect"
        import { IssueWork } from ${JSON.stringify(new URL("./issue-work.ts", import.meta.url).href)}
        import { JobStore } from ${JSON.stringify(new URL("./jobs.ts", import.meta.url).href)}
        import { CaseStore } from ${JSON.stringify(new URL("./casefile.ts", import.meta.url).href)}
        const jobs = new JobStore(${JSON.stringify(file)})
        const cases = new CaseStore(${JSON.stringify(caseDir)})
        const saved = await cases.load("12")
        saved.revisit = {
          dueAt: new Date(Date.now() + 60000).toISOString(),
          reason: "Old revisit", mediaScope: "tv", chain: 1, delayMs: 60000,
        }
        await cases.save(saved)
        let started
        const active = new Promise(resolve => { started = resolve })
        const work = new IssueWork({
          notifyQueuedEffect: () => Effect.succeed({ id: 42 }),
          retractStatusEffect: () => Effect.sync(() => {
            if (${JSON.stringify(boundary)} === "queued-notice")
              process.kill(process.pid, "SIGKILL")
          }),
          runEffect: () => Effect.sync(() => started()).pipe(
            Effect.flatMap(() => Effect.promise(() => new Promise(() => {}))),
          ),
        }, cases, jobs)
        const event = { kind: "webhook", issueId: "12",
          payload: { notification_type: "ISSUE_CREATED" } }
        await Effect.runPromise(work.enqueueEffect(event, "active"))
        await active
        if (${JSON.stringify(boundary)} === "queued-notice")
          await Effect.runPromise(work.enqueueEffect(event, "queued"))
        await work.stop("12")
        if (${JSON.stringify(boundary)} === "resumed") await work.resume("12")
        process.kill(process.pid, "SIGKILL")
      `,
    ])
    assert.equal(child.signal, "SIGKILL", child.stderr.toString())
    const jobs = new JobStore(file)
    t.after(() => jobs.close())
    const cases = new CaseStore(caseDir)
    assert.equal(jobs.get("active")?.status, "cancelling")
    if (boundary === "queued-notice")
      assert.equal(jobs.get("queued")?.status, "cancelling")
    assert.equal(await cases.isPaused("12"), boundary !== "resumed")
    const cleaned: string[] = []
    const work = new IssueWork(
      {
        notifyQueuedEffect: () => Effect.die("must not post"),
        retractStatusEffect: () => Effect.die("callback owns cleanup"),
        runEffect: () => Effect.die("must not revive model work"),
        cancelEffect: (event, status, runId) =>
          Effect.sync(() => {
            assert.equal(event.issueId, "12")
            assert.equal(status.id, runId === "queued" ? 42 : undefined)
            assert.equal(jobs.get(runId)?.status, "cancelling")
            cleaned.push(runId)
          }),
      },
      cases,
      jobs,
      () => Effect.die("cleanup must not require fresh authorization"),
    )
    work.armRevisit("12", 60_000, "Old revisit", "tv")
    assert.equal(work.revisits.pending, 0)
    await Effect.runPromise(work.restoreEffect())
    await Effect.runPromise(work.queue.drainEffect())
    assert.deepEqual(
      cleaned,
      boundary === "queued-notice" ? ["active", "queued"] : ["active"],
    )
    assert.equal((await cases.load("12")).revisit, undefined)
    assert.equal(jobs.pending().length, 0)
    await Effect.runPromise(work.restoreEffect())
    assert.equal(cleaned.length, boundary === "queued-notice" ? 2 : 1)
  })
}

test("cancellation fallback only retracts host state and cleanup failure stays recoverable", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitz-cancel-review-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "jobs.sqlite")
  const cases = new CaseStore(path.join(dir, "cases"))
  const first = new JobStore(file)
  const job = first.create("issue", {
    event: {
      kind: "webhook",
      issueId: "12",
      payload: { notification_type: "ISSUE_CREATED" },
    },
    runsAhead: 1,
  })
  await Effect.runPromise(
    first.actionEffect(job.id, "queue-notice", Effect.succeed({ id: 42 })),
  )
  first.requestCancel(job.id)
  first.close()
  const jobs = new JobStore(file)
  t.after(() => jobs.close())
  let failCleanup = true
  const work = new IssueWork(
    {
      notifyQueuedEffect: () => Effect.die("must not post"),
      runEffect: () => Effect.die("must not run"),
      retractStatusEffect: (_issueId, status, runId) =>
        Effect.suspend(() => {
          assert.equal(status.id, 42)
          assert.equal(runId, job.id)
          return failCleanup
            ? Effect.fail(
                new HttpRequestError({
                  cause: new Error("cleanup unavailable"),
                }),
              )
            : Effect.void
        }),
    },
    cases,
    jobs,
    () => Effect.die("must not authorize cleanup"),
  )
  await Effect.runPromise(work.restoreEffect())
  assert.equal(jobs.get(job.id)?.status, "cancelling")
  assert.match(jobs.get(job.id)?.error ?? "", /cleanup unavailable/)
  await work.resume("12")
  failCleanup = false
  await Effect.runPromise(work.restoreEffect())
  assert.equal(jobs.get(job.id)?.status, "cancelled")
})

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
  const work = new IssueWork(effectRunner(runner), cases)
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
  const work = new IssueWork(effectRunner(runner), cases)
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
  const jobs = new JobStore()
  t.after(() => jobs.close())
  const work = new IssueWork(
    effectRunner({
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
    }),
    cases,
    jobs,
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
  assert.equal(jobs.records()[0]?.status, "cancelling")
  assert.equal(work.revisits.pending, 0)
  await work.resume("12")
  await work.enqueue({ ...event, issueId: "13" })
  release()
  await waitForDrain(work)
  assert.deepEqual(ran, ["12", "13"])
  const saved = await cases.load("12")
  assert.deepEqual(saved.summary.facts, ["Verified change before stop"])
  assert.equal(saved.revisit, undefined)
  assert.equal(jobs.records()[0]?.status, "cancelled")
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
    override isPausedEffect(issueId: string) {
      return Effect.suspend(() => {
        this.reads += 1
        if (this.reads !== 2) return super.isPausedEffect(issueId)
        checked()
        return Effect.promise(() => reading).pipe(Effect.as(false))
      })
    }
  }
  const cases = new DelayedCaseStore(dir)
  let runs = 0
  const work = new IssueWork(
    effectRunner({
      async notifyQueued() {
        return { id: undefined }
      },
      async retractStatus() {},
      async run(): Promise<RunOutcome> {
        runs += 1
        throw new Error("stopped work must not start")
      },
    }),
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

function effectRunner(
  runner: Pick<IssueRunner, "notifyQueued" | "retractStatus" | "run">,
) {
  return {
    notifyQueuedEffect: (...args: Parameters<IssueRunner["notifyQueued"]>) =>
      Effect.tryPromise({
        try: () => runner.notifyQueued(...args),
        catch: (cause) => new HttpRequestError({ cause }),
      }),
    retractStatusEffect: (...args: Parameters<IssueRunner["retractStatus"]>) =>
      Effect.tryPromise({
        try: () => runner.retractStatus(...args),
        catch: (cause) => new HttpRequestError({ cause }),
      }),
    runEffect: (...args: Parameters<IssueRunner["run"]>) =>
      sdkPromise(() => runner.run(...args)),
  }
}

test("issue recovery keeps its run ID and adopts the recorded queue notice", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-recover-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "jobs.sqlite")
  const first = new JobStore(file)
  const event = {
    kind: "webhook" as const,
    issueId: "12",
    payload: { notification_type: "ISSUE_CREATED" as const },
  }
  const job = first.create("issue", { event, runsAhead: 1 })
  first.markRunning(job.id)
  await Effect.runPromise(
    first.actionEffect(job.id, "queue-notice", Effect.succeed({ id: 42 })),
  )
  first.close()

  const jobs = new JobStore(file)
  t.after(() => jobs.close())
  const cases = new CaseStore(path.join(dir, "cases"))
  const ran: string[] = []
  const work = new IssueWork(
    {
      notifyQueuedEffect: () => Effect.die("must not post another notice"),
      retractStatusEffect: () => Effect.void,
      runEffect: (restored, status, _signal, requestId) =>
        Effect.gen(function* () {
          assert.equal(status?.id, 42)
          assert.equal(requestId, job.id)
          ran.push(restored.issueId)
          return {
            issueId: restored.issueId,
            casefile: yield* cases.loadEffect(restored.issueId),
            directives: parseDirectives(""),
          }
        }),
    },
    cases,
    jobs,
  )
  await Effect.runPromise(work.restoreEffect())
  await Effect.runPromise(work.restoreEffect())
  await Effect.runPromise(work.queue.drainEffect())
  assert.deepEqual(ran, ["12"])
  assert.equal(jobs.get(job.id)?.status, "completed")
})

test("an uncertain queue notice fails closed without posting or running", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-notice-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const jobs = new JobStore()
  t.after(() => jobs.close())
  const job = jobs.create("issue", {
    event: {
      kind: "webhook",
      issueId: "12",
      payload: { notification_type: "ISSUE_CREATED" },
    },
    runsAhead: 1,
  })
  await assert.rejects(
    Effect.runPromise(
      jobs.actionEffect(
        job.id,
        "queue-notice",
        Effect.fail(new Error("connection lost after POST")),
      ),
    ),
  )
  let executed = false
  const work = new IssueWork(
    {
      notifyQueuedEffect: () => Effect.die("must not repeat uncertain POST"),
      retractStatusEffect: () => Effect.void,
      runEffect: () =>
        Effect.sync(() => {
          executed = true
          throw new Error("must not run")
        }),
    },
    new CaseStore(dir),
    jobs,
  )
  await Effect.runPromise(work.restoreEffect())
  await Effect.runPromise(work.queue.drainEffect())
  assert.equal(executed, false)
  assert.equal(jobs.get(job.id)?.status, "failed")
  assert.match(jobs.get(job.id)?.error ?? "", /operator review required/)
})

test("recovered comments recheck authorization and cancelled jobs stay stopped", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-recover-auth-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const jobs = new JobStore()
  t.after(() => jobs.close())
  const event = {
    kind: "webhook" as const,
    issueId: "12",
    payload: { notification_type: "ISSUE_COMMENT" as const },
  }
  const rejected = jobs.create("issue", { event, runsAhead: 0 })
  const cancelled = jobs.create("issue", { event, runsAhead: 0 })
  jobs.markCancelled(cancelled.id)
  const checked: string[] = []
  const work = new IssueWork(
    {
      notifyQueuedEffect: () => Effect.die("unauthorized notice"),
      retractStatusEffect: () => Effect.void,
      runEffect: () => Effect.die("unauthorized run"),
    },
    new CaseStore(dir),
    jobs,
    (restored) =>
      Effect.sync(() => {
        checked.push(restored.issueId)
        return false
      }),
  )
  await Effect.runPromise(work.restoreEffect())
  await work.resume("12")
  await Effect.runPromise(work.restoreEffect())
  assert.deepEqual(checked, ["12"])
  assert.equal(jobs.get(rejected.id)?.status, "cancelled")
  assert.equal(jobs.get(cancelled.id)?.status, "cancelled")
  assert.equal(work.queue.size, 0)
})

test("shutdown during a pause check cannot post an orphan queue notice", async () => {
  const checking = Deferred.makeUnsafe<void>()
  const paused = Deferred.makeUnsafe<boolean>()
  const release = Deferred.makeUnsafe<void>()
  class DelayedCaseStore extends CaseStore {
    override isPausedEffect() {
      return Deferred.succeed(checking, undefined).pipe(
        Effect.andThen(Deferred.await(paused)),
      )
    }
  }
  let notices = 0
  const work = new IssueWork(
    {
      notifyQueuedEffect: () =>
        Effect.sync(() => {
          notices += 1
          return { id: 1 }
        }),
      retractStatusEffect: () => Effect.void,
      runEffect: () => Effect.die("unexpected run"),
    },
    new DelayedCaseStore("/unused"),
  )
  work.queue.enqueueEffect(() => Deferred.await(release))
  const queued = work.enqueue({
    kind: "webhook",
    issueId: "12",
    payload: { notification_type: "ISSUE_COMMENT" },
  })
  await Effect.runPromise(Deferred.await(checking))
  work.queue.close()
  const rejected = assert.rejects(queued, /queue is closed/)
  await Effect.runPromise(Deferred.succeed(paused, false))
  await rejected
  assert.equal(notices, 0)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(work.queue.drainEffect())
})
