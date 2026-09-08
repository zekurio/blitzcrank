import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import { HttpError, HttpRequestError } from "./http.ts"
import { SeerrClient } from "./seerr.ts"

test("host Seerr effects preserve comment handles, authentication, and single writes", async (t) => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  let fail = false
  t.mock.method(globalThis, "fetch", (url: URL, request: RequestInit) => {
    assert.equal(new Headers(request.headers).get("X-Api-Key"), "secret")
    assert.equal(new Headers(request.headers).get("X-Api-User"), "23")
    calls.push({
      path: url.pathname + url.search,
      method: request.method ?? "GET",
      body: request.body,
    })
    return Promise.resolve(
      new Response(
        JSON.stringify({
          comments: [{ id: 3 }, {}, { id: 9 }, { id: 4 }],
          results: [{ id: 23 }],
        }),
        { status: fail ? 503 : 200 },
      ),
    )
  })
  const seerr = new SeerrClient(
    { url: "https://seerr.test", apiKey: "secret" },
    "23",
  )
  const post = seerr.postCommentEffect(7, "Checking")
  assert.equal(calls.length, 0)
  assert.equal(await Effect.runPromise(post), 9)
  await Effect.runPromise(seerr.updateCommentEffect(9, "Done"))
  await Effect.runPromise(seerr.deleteCommentEffect(9))
  await Effect.runPromise(seerr.setStatusEffect(7, "resolved"))
  assert.deepEqual(await Effect.runPromise(seerr.listUsersEffect()), [
    { id: 23 },
  ])
  await Effect.runPromise(seerr.getIssueEffect(7))
  assert.deepEqual(
    calls.map((call) => [call.path, call.method]),
    [
      ["/api/v1/issue/7/comment", "POST"],
      ["/api/v1/issueComment/9", "PUT"],
      ["/api/v1/issueComment/9", "DELETE"],
      ["/api/v1/issue/7/resolved", "POST"],
      ["/api/v1/user?take=200", "GET"],
      ["/api/v1/issue/7", "GET"],
    ],
  )
  assert.equal(calls[0]?.body, JSON.stringify({ message: "Checking" }))
  assert.equal(calls[1]?.body, JSON.stringify({ message: "Done" }))
  fail = true
  await assert.rejects(Effect.runPromise(post), HttpError)
  assert.equal(calls.length, 7)

  const invalid = new SeerrClient(
    { url: "https://seerr.test", apiKey: "bad\nheader" },
    undefined,
  )
  await assert.rejects(
    Effect.runPromise(invalid.getIssueEffect(7)),
    HttpRequestError,
  )
  assert.equal(calls.length, 7)
})
