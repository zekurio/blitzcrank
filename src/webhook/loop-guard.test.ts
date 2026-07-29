import assert from "node:assert/strict"
import { test } from "node:test"

import { isBotComment } from "./loop-guard.js"
import { issueIdOf, webhookText, type SeerrWebhookPayload } from "./types.js"

function commentEvent(
  comment: Record<string, string> | null,
): SeerrWebhookPayload {
  return {
    notification_type: "ISSUE_COMMENT",
    issue: { issue_id: "42" },
    comment,
  }
}

test("unsubstituted template placeholders are not values", () => {
  // Seerr leaves placeholders it does not know (e.g. the singular
  // "discordId" spelling in customized templates) literally in the payload.
  assert.equal(webhookText("{{commentedBy_email}}"), undefined)
  assert.equal(webhookText("{{commentedBy_settings_discordId}}"), undefined)
  assert.equal(webhookText(""), undefined)
  assert.equal(webhookText("   "), undefined)
  assert.equal(webhookText(undefined), undefined)
  assert.equal(webhookText(null), undefined)
  assert.equal(webhookText(" zekurio "), "zekurio")
  assert.equal(webhookText(42), "42")
})

test("only numeric issue ids are accepted", () => {
  assert.equal(
    issueIdOf({ notification_type: "X", issue: { issue_id: 9 } }),
    "9",
  )
  assert.equal(
    issueIdOf({ notification_type: "X", issue: { issue_id: "42" } }),
    "42",
  )
  assert.equal(
    issueIdOf({ notification_type: "X", issue: { issue_id: "{{issue_id}}" } }),
    undefined,
  )
  assert.equal(issueIdOf({ notification_type: "X", issue: null }), undefined)
  assert.equal(
    issueIdOf({ notification_type: "X", issue: { issue_id: "" } }),
    undefined,
  )
})

test("the bot's own comments are recognized by their marker", () => {
  const own = commentEvent({
    comment_message: "Ich prüfe die Tonspuren.\n\n[blitzcrank w/ gpt-5.6:high]",
    commentedBy_username: "{{commentedBy_username}}",
  })
  assert.equal(isBotComment(own, undefined), true)
  assert.equal(isBotComment(own, "blitzcrank"), true)
})

test("display name matching is case-insensitive and placeholder-safe", () => {
  assert.equal(
    isBotComment(
      commentEvent({ commentedBy_username: " Blitzcrank " }),
      "blitzcrank",
    ),
    true,
  )
  assert.equal(
    isBotComment(
      commentEvent({ commentedBy_username: "{{commentedBy_username}}" }),
      "{{commentedBy_username}}",
    ),
    false,
  )
  assert.equal(isBotComment(commentEvent(null), "blitzcrank"), false)
})

test("real user comments are not treated as the bot's own", () => {
  const user = commentEvent({
    comment_message: "Ja",
    commentedBy_username: "zekurio",
  })
  assert.equal(isBotComment(user, "blitzcrank"), false)
  assert.equal(isBotComment(user, undefined), false)
})
