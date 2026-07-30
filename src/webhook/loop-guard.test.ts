import assert from "node:assert/strict"
import { test } from "node:test"

import { BOT_COMMENT_MARKER, isBotComment } from "./loop-guard.js"
import type { SeerrWebhookPayload } from "./types.js"

function commentEvent(
  message: string | undefined,
  author: string | undefined,
): SeerrWebhookPayload {
  return {
    notification_type: "ISSUE_COMMENT",
    comment: {
      ...(message !== undefined ? { comment_message: message } : {}),
      ...(author !== undefined ? { commentedBy_username: author } : {}),
    },
  }
}

test("matches the comment marker regardless of the author", () => {
  const payload = commentEvent(
    `checked the queue\n\n${BOT_COMMENT_MARKER}claude-sonnet-4-5]`,
    "someone-else",
  )
  assert.equal(isBotComment(payload, "blitzcrank"), true)
  assert.equal(isBotComment(payload, undefined), true)
})

test("matches the bot display name case-insensitively", () => {
  assert.equal(
    isBotComment(commentEvent("hi", "BlitzCrank"), "blitzcrank"),
    true,
  )
  assert.equal(
    isBotComment(commentEvent("hi", " blitzcrank "), "blitzcrank"),
    true,
  )
})

test("lets a foreign comment through", () => {
  assert.equal(
    isBotComment(commentEvent("hi", "reporter"), "blitzcrank"),
    false,
  )
})

test("fails open for missing or placeholder identities", () => {
  assert.equal(isBotComment(commentEvent("hi", "reporter"), undefined), false)
  assert.equal(isBotComment(commentEvent("hi", ""), ""), false)
  assert.equal(isBotComment(commentEvent("hi", undefined), "blitzcrank"), false)
  assert.equal(
    isBotComment(commentEvent("hi", "{{commentedBy_username}}"), "blitzcrank"),
    false,
  )
  assert.equal(
    isBotComment(commentEvent("hi", "blitzcrank"), "{{botUsername}}"),
    false,
  )
})

test("handles an event without a comment object", () => {
  const payload: SeerrWebhookPayload = {
    notification_type: "ISSUE_CREATED",
    comment: null,
  }
  assert.equal(isBotComment(payload, "blitzcrank"), false)
})
