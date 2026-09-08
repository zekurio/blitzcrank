import assert from "node:assert/strict"
import test from "node:test"

import { Deferred, Effect, Option } from "effect"

import type { AutomationDefinition } from "./automations/definitions.ts"
import { AutomationDispatcher } from "./automations/dispatcher.ts"
import { SerialQueue } from "./queue.ts"
import { RevisitScheduler } from "./revisits.ts"

test("queue preserves order after failures and draining never cancels active writes", async () => {
  const queue = new SerialQueue()
  const release = Deferred.makeUnsafe<void>()
  const started = Deferred.makeUnsafe<void>()
  const ran: number[] = []
  queue.enqueueEffect(() =>
    Effect.gen(function* () {
      ran.push(1)
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(release)
      ran.push(2)
      yield* Effect.fail(new Error("write failed"))
    }),
  )
  queue.enqueueEffect(() =>
    Effect.sync(() => {
      ran.push(3)
    }),
  )
  await Effect.runPromise(Deferred.await(started))
  assert.equal(queue.size, 2)
  queue.close()
  assert.throws(() => queue.enqueueEffect(() => Effect.void), /closed/)
  const timedOut = await Effect.runPromise(
    queue.drainEffect().pipe(Effect.timeoutOption(1)),
  )
  assert.ok(Option.isNone(timedOut))
  assert.deepEqual(ran, [1])
  assert.equal(queue.size, 2)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(queue.drainEffect())
  assert.deepEqual(ran, [1, 2, 3])
  assert.equal(queue.size, 0)
})

test("automation slots reject duplicates and release after failed runs", async () => {
  const queue = new SerialQueue()
  const release = Deferred.makeUnsafe<void>()
  const definition: AutomationDefinition = {
    name: "test",
    description: "test",
    schedule: "0 0 * * *",
    enabled: true,
    mutationTools: [],
    body: "test",
    filePath: "/test.md",
  }
  let throwBeforeRun = false
  const dispatcher = new AutomationDispatcher({
    definitions: [definition],
    queue,
    run: () => {
      if (throwBeforeRun) throw new Error("run factory failed")
      return Deferred.await(release).pipe(
        Effect.andThen(Effect.fail(new Error("failed"))),
      )
    },
    publish: () => Effect.void,
    nextRun: () => undefined,
  })
  assert.equal(dispatcher.trigger("test"), "queued")
  assert.equal(dispatcher.trigger("test"), "busy")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(queue.drainEffect())
  assert.deepEqual(dispatcher.active, [])
  throwBeforeRun = true
  assert.equal(dispatcher.trigger("test"), "queued")
  await Effect.runPromise(queue.drainEffect())
  assert.deepEqual(dispatcher.active, [])
  queue.close()
  assert.equal(dispatcher.trigger("test"), "busy")
  assert.deepEqual(dispatcher.active, [])
})

test("revisit replacement and shutdown cancel sleeping fibers", async () => {
  const revisits = new RevisitScheduler()
  const fired = Deferred.makeUnsafe<void>()
  const ran: string[] = []
  revisits.scheduleEffect("12", 50, () =>
    Effect.sync(() => {
      ran.push("old")
    }),
  )
  revisits.scheduleEffect("12", 1, () =>
    Effect.gen(function* () {
      ran.push("new")
      yield* Deferred.succeed(fired, undefined)
    }),
  )
  assert.equal(revisits.pending, 1)
  await Effect.runPromise(Deferred.await(fired))
  assert.equal(revisits.pending, 0)
  revisits.scheduleEffect("13", 1, () =>
    Effect.sync(() => {
      ran.push("stopped")
    }),
  )
  revisits.stop()
  await Effect.runPromise(Effect.sleep(60))
  assert.equal(revisits.pending, 0)
  assert.deepEqual(ran, ["new"])
})
