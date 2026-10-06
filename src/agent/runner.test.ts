import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import { CaseStore } from "../casefile.ts"
import type { Config } from "../config.ts"
import { IssueWork } from "../issue-work.ts"
import { JobStore } from "../jobs.ts"
import { HttpError } from "../services/http.ts"
import { SeerrClient } from "../services/seerr.ts"
import { MAX_RESULT_CHARS } from "../tools/common.ts"
import { RunContext } from "../tools/context.ts"
import {
  loadIssueContextEffect,
  publishCommentEffect,
  IssueRunner,
  type IssueEvent,
  type RunOutcome,
} from "./runner.ts"

test("issue startup always reads live state and records the supplied evidence", async () => {
  const issue = {
    id: 42,
    media: { mediaType: "movie", tmdbId: 987 },
    comments: [{ message: "The affected track is still missing." }],
    problemSeason: 2,
    problemEpisode: 3,
  }
  const cases: Array<{ event: IssueEvent; scope: "movie" | "tv" }> = [
    {
      event: {
        kind: "webhook",
        issueId: "42",
        payload: {
          notification_type: "ISSUE_CREATED",
          media: { media_type: "tv" },
        },
      },
      scope: "tv",
    },
    {
      event: {
        kind: "webhook",
        issueId: "42",
        payload: { notification_type: "ISSUE_COMMENT" },
      },
      scope: "movie",
    },
    {
      event: {
        kind: "revisit",
        issueId: "42",
        reason: "Check import",
        mediaScope: "tv",
      },
      scope: "tv",
    },
  ]
  for (const entry of cases) {
    const calls: Array<string | number> = []
    const ctx = new RunContext()
    const context = await Effect.runPromise(
      loadIssueContextEffect(
        entry.event,
        {
          getIssueEffect: (id) => {
            calls.push(id)
            return Effect.succeed(issue)
          },
        },
        ctx,
      ),
    )
    assert.deepEqual(calls, ["42"])
    assert.equal(context.mediaScope, entry.scope)
    assert.match(context.text, /GET \/api\/v1\/issue\/42/)
    assert.ok(context.text.includes(JSON.stringify(issue, null, 2)))
    assert.equal(ctx.sawValue("seerr", 987), true)
    assert.equal(ctx.sawValue("radarr", 987), false)
    assert.deepEqual(ctx.snapshot.evidence, [
      {
        service: "seerr",
        path: "/api/v1/issue/42",
        body: JSON.stringify(issue),
      },
    ])
    assert.deepEqual(ctx.counts, { mutations: 0, deletes: 0 })
  }
})

test("issue startup bounds context, withholds unknown Arr scope and fails on read errors", async () => {
  const event: IssueEvent = {
    kind: "webhook",
    issueId: "42",
    payload: { notification_type: "ISSUE_CREATED" },
  }
  const ctx = new RunContext()
  const context = await Effect.runPromise(
    loadIssueContextEffect(
      event,
      {
        getIssueEffect: () =>
          Effect.succeed({
            media: { mediaType: "unknown" },
            comments: [{ message: "x".repeat(MAX_RESULT_CHARS * 2) }],
          }),
      },
      ctx,
    ),
  )
  assert.equal(context.mediaScope, undefined)
  assert.match(context.text, /\[truncated/)
  assert.ok(context.text.length < MAX_RESULT_CHARS + 250)

  const failed = new RunContext()
  await assert.rejects(
    Effect.runPromise(
      loadIssueContextEffect(
        event,
        {
          getIssueEffect: () =>
            Effect.fail(new HttpError(503, "http://seerr.test", "offline")),
        },
        failed,
      ),
    ),
    /offline/,
  )
  assert.deepEqual(failed.snapshot.evidence, [])
})

test("final comments adopt the status handle and failed deletions retain it", async () => {
  const calls: string[] = []
  const seerr = {
    postCommentEffect: () => {
      calls.push("post")
      return Effect.succeed(1)
    },
    updateCommentEffect: () => {
      calls.push("update")
      return Effect.succeed(null)
    },
    deleteCommentEffect: () => {
      calls.push("delete")
      return Effect.fail(new HttpError(503, "http://seerr.test", "offline"))
    },
  }
  const status = { id: 9 as number | undefined }
  const retract = publishCommentEffect(seerr, "1", status, undefined)
  assert.deepEqual(calls, [])
  await assert.rejects(Effect.runPromise(retract), /offline/)
  assert.equal(status.id, 9)
  await Effect.runPromise(publishCommentEffect(seerr, "1", status, "answer"))
  assert.equal(status.id, undefined)
  await Effect.runPromise(retract)
  assert.deepEqual(calls, ["delete", "update"])
  await Effect.runPromise(
    publishCommentEffect(seerr, "1", status, "new answer"),
  )
  assert.deepEqual(calls, ["delete", "update", "post"])
})

test("recovery initialization failure never retracts a possible final answer", async (t) => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "blitzcrank-publish-recovery-"),
  )
  t.after(() => rm(dir, { recursive: true, force: true }))
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
  })
  const jobs = new JobStore()
  t.after(() => jobs.close())
  const deleted: number[] = []
  t.mock.method(SeerrClient.prototype, "getIssueEffect", () =>
    Effect.fail(new HttpError(503, "http://seerr.test", "offline")),
  )
  t.mock.method(SeerrClient.prototype, "deleteCommentEffect", (id: number) =>
    Effect.sync(() => {
      deleted.push(id)
    }),
  )
  const runner = new IssueRunner(
    testConfig(dir),
    modelRuntime,
    "anthropic/claude-sonnet-4-5",
    jobs,
  )
  const event: IssueEvent = {
    kind: "webhook",
    issueId: "42",
    payload: { notification_type: "ISSUE_CREATED" },
  }
  for (const completed of [true, false]) {
    const job = jobs.create("issue", { event })
    const publication = jobs.actionEffect(
      job.id,
      "publish-comment",
      completed ? Effect.void : Effect.fail(new Error("connection lost")),
    )
    if (completed) await Effect.runPromise(publication)
    if (!completed) await assert.rejects(Effect.runPromise(publication))
    await assert.rejects(
      Effect.runPromise(
        runner.runEffect(event, { id: 777 }, undefined, job.id),
      ),
      /offline/,
    )
    assert.deepEqual(deleted, [])
  }
})

test("a completed issue submission recovers without another post or usage increment", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-issue-durable-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
  })
  runtime.checkAuth = async () => ({ type: "api_key" })
  let requests = 0
  runtime.streamSimple = () => {
    requests++
    const message: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "RESOLVE_ISSUE: NO\n\nVerified available." },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      timestamp: 1,
      stopReason: "stop",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    const stream = createAssistantMessageEventStream()
    stream.push({ type: "done", reason: "stop", message })
    return stream
  }
  t.mock.method(SeerrClient.prototype, "getIssueEffect", () =>
    Effect.succeed({ id: 42, media: { mediaType: "movie" } }),
  )
  let posts = 0
  let deletes = 0
  t.mock.method(SeerrClient.prototype, "postCommentEffect", () =>
    Effect.sync(() => {
      posts++
      return 99
    }),
  )
  t.mock.method(SeerrClient.prototype, "deleteCommentEffect", () =>
    Effect.sync(() => {
      deletes++
    }),
  )
  const jobs = new JobStore()
  t.after(() => jobs.close())
  const event: IssueEvent = {
    kind: "webhook",
    issueId: "42",
    payload: { notification_type: "ISSUE_CREATED" },
  }
  const job = jobs.create("issue", { event })
  const runner = new IssueRunner(
    testConfig(dir),
    runtime,
    "anthropic/claude-sonnet-4-5",
    jobs,
  )
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome: RunOutcome = await Effect.runPromise(
      runner.runEffect(event, { id: undefined }, undefined, job.id),
    )
    assert.equal(outcome.casefile.spend.runs, 1)
    assert.equal(outcome.casefile.spend.tokens, 15)
    assert.equal(outcome.casefile.runs.length, 1)
    assert.equal(outcome.casefile.lastAnswer, "Verified available.")
  }
  await Effect.runPromise(runner.cancelEffect(event, { id: 99 }, job.id))
  const saved = await new CaseStore(path.join(dir, "cases")).load("42")
  assert.equal(saved.spend.runs, 1)
  assert.equal(saved.spend.tokens, 15)
  assert.equal(saved.lastAnswer, "Verified available.")
  assert.equal(saved.runs[0]?.commented, true)
  assert.equal(requests, 1)
  assert.equal(posts, 1)
  assert.equal(deletes, 0)
})

test(
  "the real Durable issue runner settles active cancellation before resume",
  { timeout: 10_000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-real-stop-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
    })
    runtime.checkAuth = async () => ({ type: "api_key" })
    let signalStarted = () => {}
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    let requests = 0
    runtime.streamSimple = (_model, _context, options) => {
      requests++
      const stream = createAssistantMessageEventStream()
      const aborted: AssistantMessage = {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        timestamp: 1,
        stopReason: "aborted",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }
      options?.signal?.addEventListener(
        "abort",
        () => {
          stream.push({ type: "error", reason: "aborted", error: aborted })
        },
        { once: true },
      )
      signalStarted()
      return stream
    }
    t.mock.method(SeerrClient.prototype, "getIssueEffect", () =>
      Effect.succeed({ id: 42, media: { mediaType: "movie" } }),
    )
    const jobs = new JobStore()
    t.after(() => jobs.close())
    const cases = new CaseStore(path.join(dir, "cases"))
    const runner = new IssueRunner(
      testConfig(dir),
      runtime,
      "anthropic/claude-sonnet-4-5",
      jobs,
    )
    const work = new IssueWork(runner, cases, jobs)
    t.after(() => work.revisits.stop())
    await work.enqueue({
      kind: "webhook",
      issueId: "42",
      payload: { notification_type: "ISSUE_CREATED" },
    })
    await started
    await work.stop("42")
    await Effect.runPromise(work.queue.drainEffect())
    assert.equal(jobs.records()[0]?.status, "cancelled")
    assert.equal(jobs.pending().length, 0)
    assert.equal((await cases.load("42")).spend.runs, 1)
    await work.resume("42")
    await Effect.runPromise(work.restoreEffect())
    assert.equal((await cases.load("42")).spend.runs, 1)
    assert.equal(requests, 1)
    work.armRevisit("42", 60_000, "Check import", "movie")
    assert.equal(work.revisits.pending, 1)
  },
)

function testConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8484,
    automationsDir: "automations",
    webhookSecret: undefined,
    model: undefined,
    automationModel: undefined,
    automationModels: {},
    authPath: undefined,
    modelsPath: undefined,
    language: "English",
    web: { provider: "none" },
    seerrBotUserId: undefined,
    seerrBotUsername: undefined,
    seerr: { url: "http://seerr.test", apiKey: "test" },
    sonarr: undefined,
    radarr: undefined,
    sabnzbd: undefined,
    jellyfin: undefined,
    media: undefined,
    discord: undefined,
  }
}
