import assert from "node:assert/strict"
import test from "node:test"

import { Cause, Effect, Exit } from "effect"

import { HttpError } from "../../services/http.ts"
import type { SeerrClient } from "../../services/seerr.ts"
import { createCommentGateEffect } from "./comment-gate.ts"
import type { SeerrWebhookPayload } from "./types.ts"

test("comment authorization keeps email authoritative and fails closed on service errors", async () => {
  const payload: SeerrWebhookPayload = {
    notification_type: "ISSUE_COMMENT",
    issue: { issue_id: "7" },
    comment: {
      commentedBy_email: "Reporter@example.com",
      commentedBy_username: "Reporter",
    },
  }
  let lookups = 0
  const seerr: Pick<SeerrClient, "getIssueEffect" | "listUsersEffect"> = {
    getIssueEffect: () =>
      Effect.succeed({
        createdBy: { email: "reporter@example.com", displayName: "Reporter" },
      }),
    listUsersEffect: () =>
      Effect.sync(() => {
        lookups += 1
        return []
      }),
  }
  const gate = createCommentGateEffect(seerr)
  assert.equal(await Effect.runPromise(gate(payload)), true)
  assert.equal(lookups, 0)
  payload.comment = {
    commentedBy_email: "stranger@example.com",
    commentedBy_username: "Reporter",
  }
  assert.equal(await Effect.runPromise(gate(payload)), false)
  assert.equal(lookups, 1)
  for (const permissions of [2, 1_048_576]) {
    seerr.listUsersEffect = () =>
      Effect.succeed([{ email: "stranger@example.com", permissions }])
    assert.equal(await Effect.runPromise(gate(payload)), true)
  }
  seerr.listUsersEffect = () =>
    Effect.fail(new HttpError(503, "https://seerr.test/user", "down"))
  assert.equal(await Effect.runPromise(gate(payload)), false)
  seerr.getIssueEffect = () =>
    Effect.fail(new HttpError(503, "https://seerr.test/issue/7", "down"))
  assert.equal(await Effect.runPromise(gate(payload)), false)
  seerr.getIssueEffect = () => Effect.die(new Error("malformed response"))
  assert.equal(await Effect.runPromise(gate(payload)), false)
  seerr.getIssueEffect = () => Effect.interrupt
  const interrupted = await Effect.runPromiseExit(gate(payload))
  assert.equal(
    Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause),
    true,
  )
  payload.comment = { commentedBy_email: "{{commentedBy_email}}" }
  assert.equal(await Effect.runPromise(gate(payload)), false)
})
