import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import { HttpError } from "../services/http.ts"
import { MAX_RESULT_CHARS } from "../tools/common.ts"
import { RunContext } from "../tools/context.ts"
import {
  loadIssueContextEffect,
  publishCommentEffect,
  type IssueEvent,
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
