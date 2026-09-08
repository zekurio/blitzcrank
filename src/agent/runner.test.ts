import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import { publishCommentEffect } from "./runner.ts"

test("final comments adopt the status handle and failed deletions retain it", async () => {
  const calls: string[] = []
  const seerr = {
    postComment: () => {
      calls.push("post")
      return Promise.resolve(1)
    },
    updateComment: () => {
      calls.push("update")
      return Promise.resolve(null)
    },
    deleteComment: () => {
      calls.push("delete")
      return Promise.reject(new Error("offline"))
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
