import assert from "node:assert/strict"
import { test } from "node:test"

import { SerialQueue } from "../queue.js"
import type { AutomationDefinition } from "./definitions.js"
import { AutomationDispatcher } from "./dispatcher.js"
import type { AutomationReport } from "./runner.js"

test("first trigger is queued", () => {
  const harness = createHarness(["cleanup"])
  assert.equal(harness.dispatcher.trigger("cleanup"), "queued")
  assert.equal(harness.queue.size, 1)
})

test("a second trigger while running is busy and enqueues nothing", async () => {
  const harness = createHarness(["cleanup"])
  assert.equal(harness.dispatcher.trigger("cleanup"), "queued")
  await tick()
  assert.deepEqual(harness.started, ["cleanup"])

  assert.equal(harness.dispatcher.trigger("cleanup"), "busy")
  assert.equal(harness.queue.size, 1)
  assert.deepEqual(harness.started, ["cleanup"])
  assert.deepEqual(harness.dispatcher.active, ["cleanup"])

  harness.finish("cleanup")
  await drain(harness.queue)
})

test("the slot is released once the run settles", async () => {
  const harness = createHarness(["cleanup"])
  harness.dispatcher.trigger("cleanup")
  harness.finish("cleanup")
  await drain(harness.queue)

  assert.deepEqual(harness.dispatcher.active, [])
  assert.equal(harness.dispatcher.trigger("cleanup"), "queued")
  harness.finish("cleanup")
  await drain(harness.queue)
  assert.deepEqual(harness.started, ["cleanup", "cleanup"])
  assert.deepEqual(harness.published, ["cleanup", "cleanup"])
})

test("a throwing run still releases the slot", async () => {
  const harness = createHarness(["cleanup"])
  harness.dispatcher.trigger("cleanup")
  harness.fail("cleanup", new Error("boom"))
  await drain(harness.queue)

  assert.deepEqual(harness.dispatcher.active, [])
  assert.deepEqual(harness.published, [])
  assert.equal(harness.dispatcher.trigger("cleanup"), "queued")
  harness.finish("cleanup")
  await drain(harness.queue)
})

test("an unknown name never reaches the queue", () => {
  const harness = createHarness(["cleanup"])
  assert.equal(harness.dispatcher.trigger("nope"), "unknown")
  assert.equal(harness.queue.size, 0)
  assert.deepEqual(harness.dispatcher.active, [])
})

test("different automations queue independently", async () => {
  const harness = createHarness(["cleanup", "audit"])
  assert.equal(harness.dispatcher.trigger("cleanup"), "queued")
  assert.equal(harness.dispatcher.trigger("audit"), "queued")
  assert.equal(harness.queue.size, 2)
  assert.deepEqual(harness.dispatcher.active, ["cleanup", "audit"])

  harness.finish("cleanup")
  harness.finish("audit")
  await drain(harness.queue)
  assert.deepEqual(harness.started, ["cleanup", "audit"])
})

/**
 * A real SerialQueue plus a runner whose completion the test controls, so
 * "queued or in flight" can be observed while a run is genuinely in flight.
 */
function createHarness(names: string[]) {
  const queue = new SerialQueue()
  const started: string[] = []
  const published: string[] = []
  const outcomes = new Map<string, (report: AutomationReport) => void>()
  const failures = new Map<string, (err: Error) => void>()

  const dispatcher = new AutomationDispatcher({
    definitions: names.map(definition),
    queue,
    run: (def) =>
      new Promise<AutomationReport>((resolve, reject) => {
        started.push(def.name)
        outcomes.set(def.name, resolve)
        failures.set(def.name, reject)
      }),
    publish: async (report) => {
      published.push(report.name)
    },
    nextRun: () => undefined,
  })

  return {
    queue,
    dispatcher,
    started,
    published,
    /** Completes the run for `name`, whether or not it has started yet. */
    finish: (name: string) =>
      settle(outcomes, name, (resolve) => resolve(report(name))),
    fail: (name: string, err: Error) =>
      settle(failures, name, (reject) => reject(err)),
  }
}

/** The runner may not have been called yet; retry until the queue gets to it. */
function settle<T>(
  handlers: Map<string, T>,
  name: string,
  apply: (handler: T) => void,
): void {
  const timer = setInterval(() => {
    const handler = handlers.get(name)
    if (!handler) return
    handlers.delete(name)
    clearInterval(timer)
    apply(handler)
  }, 1)
  timer.unref?.()
}

async function drain(queue: SerialQueue): Promise<void> {
  while (queue.size > 0) await tick()
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 5).unref?.()
  })
}

function definition(name: string): AutomationDefinition {
  return {
    name,
    description: `test ${name}`,
    schedule: "0 4 * * *",
    enabled: true,
    capabilities: [],
    mutationBudget: 1,
    deletionBudget: 0,
    body: "do nothing",
    filePath: `automations/${name}.md`,
  }
}

function report(name: string): AutomationReport {
  return {
    name,
    status: "ok",
    body: "",
    empty: true,
    malformed: false,
    mutations: 0,
    deletes: 0,
    tokens: 0,
  }
}
