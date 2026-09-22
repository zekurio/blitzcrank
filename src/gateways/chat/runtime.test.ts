import assert from "node:assert/strict"
import test from "node:test"

import { Deferred, Effect, Option } from "effect"

import { GatewayConnection } from "./runtime.ts"

test("a pending connection stays owned when shutdown waiting reaches its deadline", async () => {
  const release = Deferred.makeUnsafe<void>()
  const started = Deferred.makeUnsafe<void>()
  const events: string[] = []
  const connection = new GatewayConnection({
    id: "discord",
    startEffect: () =>
      Effect.gen(function* () {
        events.push("login")
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
      }),
    reportEffect: () => Effect.void,
    stopEffect: () =>
      Effect.sync(() => {
        events.push("stop")
      }),
  })
  await Effect.runPromise(Deferred.await(started))
  assert.equal(connection.state, "connecting")
  const waiting = await Effect.runPromise(
    connection.stopEffect().pipe(Effect.timeoutOption(1)),
  )
  assert.ok(Option.isNone(waiting))
  assert.equal(connection.state, "connecting")
  assert.deepEqual(events, ["login"])
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(connection.stopEffect())
  assert.deepEqual(events, ["login", "stop"])
})

test("a failed connection remains owned for shutdown and is never retried", async () => {
  const events: string[] = []
  const connection = new GatewayConnection({
    id: "discord",
    startEffect: () => {
      events.push("login")
      throw new Error("offline")
    },
    reportEffect: () => Effect.void,
    stopEffect: () =>
      Effect.sync(() => {
        events.push("stop")
      }),
  })
  await Effect.runPromise(connection.stopEffect())
  assert.equal(connection.state, "failed")
  assert.deepEqual(events, ["login", "stop"])
})

test("reports are delivered only after startup completes", async () => {
  const release = Deferred.makeUnsafe<void>()
  const events: string[] = []
  const report = {
    name: "test",
    status: "ok" as const,
    body: "done",
    reads: 0,
    mutations: 0,
    deletes: 0,
    tokens: 0,
    malformed: false,
    empty: false,
  }
  const connection = new GatewayConnection({
    id: "discord",
    startEffect: () => Deferred.await(release),
    reportEffect: () =>
      Effect.sync(() => {
        events.push("report")
      }),
    stopEffect: () => Effect.void,
  })
  await Effect.runPromise(connection.reportEffect(report))
  assert.deepEqual(events, [])
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(connection.reportEffect(report))
  assert.deepEqual(events, ["report"])
  await Effect.runPromise(connection.stopEffect())
})
