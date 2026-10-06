import assert from "node:assert/strict"
import test from "node:test"

import { Cause, Effect, Exit } from "effect"

import {
  buildAutomationReportTool,
  type AutomationReportCapture,
} from "../automations/report.js"
import {
  buildDiscordTriageTool,
  type DiscordTriageCapture,
} from "../discord/triage.js"
import { HttpError } from "../services/http.js"
import { SeerrClient } from "../services/seerr.js"
import { runMutation, ToolError } from "./common.js"
import { RunContext } from "./context.js"
import { buildProgressTool, type StatusComment } from "./progress.js"
import { executeTool } from "./test-fixture.js"

test("mutation gates are lazy and run before the counter or write factory", async () => {
  const ctx = new RunContext()
  let writes = 0
  const mutation = runMutation(ctx, {
    kind: "delete",
    evidence: [
      { service: "sonarr", value: 7, hint: "episode file", identity: true },
    ],
    perform: () => {
      writes += 1
      return Effect.succeed({ id: 7 })
    },
  })
  assert.equal(writes, 0)
  assert.deepEqual(ctx.counts, { mutations: 0, deletes: 0 })
  ctx.recordRead("sonarr", "/api/v3/episodefile", '{"id":7}')
  const rejected = await Effect.runPromise(
    mutation.pipe(
      Effect.catchTag("ToolError", (error) => Effect.succeed(error)),
    ),
  )
  assert.ok(rejected instanceof ToolError)
  assert.match(rejected.message, /identity/)
  assert.equal(writes, 0)
  assert.deepEqual(ctx.counts, { mutations: 0, deletes: 0 })

  ctx.recordIdentity("sonarr", 7)
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

test("terminal tools return native Durable control and captured details", async () => {
  const report: AutomationReportCapture = { submissions: [] }
  const reportTool = buildAutomationReportTool(report)
  const submitted = { status: "ok", body: "Verified" }
  const reportResult = await executeTool(reportTool, submitted)
  assert.deepEqual(reportResult.control, { terminate: true })
  assert.deepEqual(reportResult.details, submitted)
  assert.deepEqual(report.submissions, [submitted])
  assert.equal(reportTool.replay, "safe")

  const triage: DiscordTriageCapture = { submissions: [] }
  const triageTool = buildDiscordTriageTool(triage)
  const decision = { route: "thread", threadName: " Show missing audio " }
  const triageResult = await executeTool(triageTool, decision)
  const normalized = { route: "thread", threadName: "Show missing audio" }
  assert.deepEqual(triageResult.control, { terminate: true })
  assert.deepEqual(triageResult.details, normalized)
  assert.deepEqual(triage.submissions, [normalized])
  assert.equal(triageTool.replay, "safe")
})

test("progress quota survives rebuilding the registration from host state", async (t) => {
  const seerr = new SeerrClient(
    { url: "http://seerr.test", apiKey: "test" },
    undefined,
  )
  const update = t.mock.method(seerr, "updateCommentEffect", () => Effect.void)
  const status: StatusComment = { id: 7, calls: 3 }
  const build = () => buildProgressTool(seerr, 1, "anchor", "English", status)
  const tool = build()
  assert.notEqual(tool.replay, "safe")
  await executeTool(tool, { message: "Checking the audio" })
  assert.equal(status.calls, 4)
  assert.equal(update.mock.callCount(), 1)
  await assert.rejects(
    executeTool(build(), { message: "Checking again" }),
    /at most 4/,
  )
  assert.equal(status.calls, 4)
  assert.equal(update.mock.callCount(), 1)
})
