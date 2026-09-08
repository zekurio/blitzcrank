import assert from "node:assert/strict"
import test from "node:test"

import { Cause, Effect, Exit } from "effect"

import { HttpError } from "../services/http.js"
import { runMutation, ToolError } from "./common.js"
import { RunContext } from "./context.js"

test("mutation gates are lazy and run before the counter or write factory", async () => {
  const ctx = new RunContext()
  let writes = 0
  const mutation = runMutation(ctx, {
    kind: "delete",
    evidence: [{ service: "anvil", value: 7, hint: "job", identity: true }],
    perform: () => {
      writes += 1
      return Effect.succeed({ id: 7 })
    },
  })
  assert.equal(writes, 0)
  assert.deepEqual(ctx.counts, { mutations: 0, deletes: 0 })
  ctx.recordRead("anvil", "jobs", '{"id":7}')
  const rejected = await Effect.runPromise(
    mutation.pipe(
      Effect.catchTag("ToolError", (error) => Effect.succeed(error)),
    ),
  )
  assert.ok(rejected instanceof ToolError)
  assert.match(rejected.message, /identity/)
  assert.equal(writes, 0)
  assert.deepEqual(ctx.counts, { mutations: 0, deletes: 0 })

  ctx.recordIdentity("anvil", 7)
  assert.deepEqual(await Effect.runPromise(mutation), { result: { id: 7 } })
  assert.equal(writes, 1)
  assert.deepEqual(ctx.counts, { mutations: 1, deletes: 1 })
})

test("write failures propagate once and skip verification", async () => {
  const ctx = new RunContext()
  const failure = new HttpError(503, "http://service.test", "unavailable")
  let writes = 0
  let verifications = 0
  await assert.rejects(
    Effect.runPromise(
      runMutation(ctx, {
        kind: "mutate",
        perform: () => {
          writes += 1
          return Effect.fail(failure)
        },
        verify: () => {
          verifications += 1
          return Effect.succeed({})
        },
      }),
    ),
    (error) => error === failure,
  )
  assert.equal(writes, 1)
  assert.equal(verifications, 0)
  assert.deepEqual(ctx.counts, { mutations: 1, deletes: 0 })
})

test("typed and thrown verification errors retain the write result without retry", async () => {
  const failure = new HttpError(503, "http://service.test", "unavailable")
  for (const verify of [
    () => Effect.fail(failure),
    () => {
      throw failure
    },
    () =>
      Effect.sync(() => {
        throw failure
      }),
  ]) {
    const ctx = new RunContext()
    let writes = 0
    const outcome = await Effect.runPromise(
      runMutation(ctx, {
        kind: "mutate",
        perform: () =>
          Effect.sync(() => {
            writes += 1
            return { id: 7 }
          }),
        verify,
      }),
    )
    assert.deepEqual(outcome, {
      result: { id: 7 },
      verificationError: failure.message,
    })
    assert.equal(writes, 1)
  }
})

test("verification interruption stays interrupted", async () => {
  const ctx = new RunContext()
  let writes = 0
  const exit = await Effect.runPromiseExit(
    runMutation(ctx, {
      kind: "mutate",
      perform: () =>
        Effect.sync(() => {
          writes += 1
          return { id: 7 }
        }),
      verify: () => Effect.interrupt,
    }),
  )
  assert.ok(Exit.isFailure(exit))
  assert.ok(Cause.hasInterrupts(exit.cause))
  assert.equal(writes, 1)
})
