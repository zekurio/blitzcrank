import assert from "node:assert/strict"
import { test } from "node:test"

import { Effect } from "effect"

import { JobStore } from "../jobs.ts"
import { SerialQueue } from "../queue.ts"
import type { AutomationDefinition } from "./definitions.ts"
import { AutomationDispatcher } from "./dispatcher.ts"
import type { AutomationReport } from "./runner.ts"

const definition: AutomationDefinition = {
  name: "check",
  description: "Check",
  schedule: "0 * * * *",
  enabled: true,
  mutationTools: [],
  body: "Check things",
  filePath: "automations/check.md",
}
const report: AutomationReport = {
  name: "check",
  status: "ok",
  body: "",
  empty: true,
  malformed: false,
  reads: 0,
  mutations: 0,
  deletes: 0,
  tokens: 0,
}

test("admission is durable before run, busy slots release after publish failure", async (t) => {
  const jobs = new JobStore()
  t.after(() => jobs.close())
  const queue = new SerialQueue()
  queue.enqueueEffect(() => Effect.sleep("10 millis"))
  let calls = 0
  const dispatcher = new AutomationDispatcher({
    definitions: [definition],
    queue,
    jobs,
    nextRun: () => undefined,
    run: (_def, id) =>
      Effect.sync(() => {
        assert.equal(jobs.get(id)?.status, "running")
        calls++
        return report
      }),
    publish: () => Effect.fail(new Error("sink failed")),
  })
  assert.equal(dispatcher.trigger("missing"), "unknown")
  assert.equal(dispatcher.trigger("check"), "queued")
  assert.equal(dispatcher.trigger("check"), "busy")
  await Effect.runPromise(queue.drainEffect())
  assert.equal(calls, 1)
  assert.deepEqual(dispatcher.active, [])
  assert.equal(jobs.records()[0]?.status, "failed")
  assert.equal(dispatcher.trigger("check"), "queued")
  await Effect.runPromise(queue.drainEffect())
  queue.close()
  assert.equal(dispatcher.trigger("check"), "busy")
})

test("restore fails closed on changed definitions and holds exactly one busy slot", async (t) => {
  const jobs = new JobStore()
  t.after(() => jobs.close())
  const job = jobs.create(
    "automation",
    { name: definition.name, definition },
    { busyKey: "automation:check" },
  )
  jobs.markRunning(job.id)
  const queue = new SerialQueue()
  queue.enqueueEffect(() => Effect.sleep("10 millis"))
  let calls = 0
  const dispatcher = new AutomationDispatcher({
    definitions: [definition],
    queue,
    jobs,
    nextRun: () => undefined,
    run: (_def, id) =>
      Effect.sync(() => {
        assert.equal(id, job.id)
        calls++
        return report
      }),
    publish: () => Effect.void,
  })
  dispatcher.restore()
  dispatcher.restore()
  assert.equal(dispatcher.trigger("check"), "busy")
  await Effect.runPromise(queue.drainEffect())
  assert.equal(calls, 1)
  assert.equal(jobs.get(job.id)?.status, "completed")
  const changed = jobs.create(
    "automation",
    {
      name: definition.name,
      definition: { ...definition, mutationTools: ["delete"] },
    },
    { busyKey: "automation:check" },
  )
  dispatcher.restore()
  assert.equal(jobs.get(changed.id)?.status, "failed")
  assert.deepEqual(dispatcher.active, [])
})

test("an uncertain report is not posted again on recovery", async (t) => {
  const jobs = new JobStore()
  t.after(() => jobs.close())
  const job = jobs.create(
    "automation",
    { name: definition.name, definition },
    { busyKey: "automation:check" },
  )
  await assert.rejects(
    Effect.runPromise(
      jobs.actionEffect(job.id, "publish", Effect.fail("lost")),
    ),
  )
  const queue = new SerialQueue()
  let posts = 0
  const dispatcher = new AutomationDispatcher({
    definitions: [definition],
    queue,
    jobs,
    nextRun: () => undefined,
    run: () => Effect.succeed(report),
    publish: () =>
      Effect.sync(() => {
        posts++
      }),
  })
  dispatcher.restore()
  await Effect.runPromise(queue.drainEffect())
  assert.equal(posts, 0)
  assert.equal(jobs.get(job.id)?.status, "failed")
})

test("a Nix store path change does not invalidate identical automation policy", async (t) => {
  const jobs = new JobStore()
  t.after(() => jobs.close())
  const job = jobs.create("automation", {
    name: definition.name,
    definition: {
      ...definition,
      filePath: "/nix/store/old-blitzcrank/automations/check.md",
    },
  })
  const queue = new SerialQueue()
  let runs = 0
  const dispatcher = new AutomationDispatcher({
    definitions: [
      {
        ...definition,
        filePath: "/nix/store/new-blitzcrank/automations/check.md",
      },
    ],
    jobs,
    queue,
    nextRun: () => undefined,
    run: () =>
      Effect.sync(() => {
        runs++
        return report
      }),
    publish: () => Effect.void,
  })
  dispatcher.restore()
  await Effect.runPromise(queue.drainEffect())
  assert.equal(runs, 1)
  assert.equal(jobs.get(job.id)?.status, "completed")
})
