import assert from "node:assert/strict"
import { test } from "node:test"

import { emptyCase } from "../casefile.js"
import type { SeerrClient } from "../services/seerr.js"
import type { StatusComment } from "../tools/index.js"
import { budgetStop, publishComment } from "./runner.js"

type CommentApi = Pick<
  SeerrClient,
  "postComment" | "updateComment" | "deleteComment"
>

function recordingSeerr(): { api: CommentApi; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    api: {
      postComment: async (issueId, message) => {
        calls.push(`post ${issueId} ${message}`)
        return 77
      },
      updateComment: async (commentId, message) => {
        calls.push(`update ${commentId} ${message}`)
        return {}
      },
      deleteComment: async (commentId) => {
        calls.push(`delete ${commentId}`)
        return {}
      },
    },
  }
}

test("posts a new comment when no status line exists", async () => {
  const seerr = recordingSeerr()
  const status: StatusComment = { id: undefined }
  await publishComment(seerr.api, "9", status, "done")
  assert.deepEqual(seerr.calls, ["post 9 done"])
})

test("overwrites the live status line instead of adding a comment", async () => {
  const seerr = recordingSeerr()
  const status: StatusComment = { id: 12 }
  await publishComment(seerr.api, "9", status, "done")
  assert.deepEqual(seerr.calls, ["update 12 done"])
})

test("removes the status line when there is no final comment", async () => {
  const seerr = recordingSeerr()
  const status: StatusComment = { id: 12 }
  await publishComment(seerr.api, "9", status, undefined)
  assert.deepEqual(seerr.calls, ["delete 12"])
})

test("stays silent when nothing was posted and nothing is to say", async () => {
  const seerr = recordingSeerr()
  const status: StatusComment = { id: undefined }
  await publishComment(seerr.api, "9", status, undefined)
  assert.deepEqual(seerr.calls, [])
})

test("an issue below its budget runs normally", () => {
  const file = emptyCase("9")
  file.spend.cost = 4.99
  assert.deepEqual(budgetStop(file, 5), { skip: false, notify: false })
})

test("an issue at its budget never starts a session", () => {
  const file = emptyCase("9")
  file.spend.cost = 5
  assert.deepEqual(budgetStop(file, 5), { skip: true, notify: true })
})

test("the budget comment is posted once, not on every later trigger", () => {
  const file = emptyCase("9")
  file.spend.cost = 7.5
  file.budgetNotified = true
  assert.deepEqual(budgetStop(file, 5), { skip: true, notify: false })
})

test("a zero budget disables the ceiling", () => {
  const file = emptyCase("9")
  file.spend.cost = 999
  assert.deepEqual(budgetStop(file, 0), { skip: false, notify: false })
})
