import assert from "node:assert/strict"
import { test } from "node:test"

import type { SeerrClient, SeerrUser } from "../services/seerr.js"
import { createCommentGate } from "./comment-gate.js"
import type { SeerrWebhookPayload } from "./types.js"

const reporter: SeerrUser = {
  id: 7,
  email: "alex@example.com",
  username: "Alex",
  permissions: 4_194_304, // CREATE_ISSUES
}
const admin: SeerrUser = {
  id: 1,
  email: "root@example.com",
  displayName: "root",
  permissions: 2, // ADMIN
}
const moderator: SeerrUser = {
  id: 3,
  email: "mod@example.com",
  username: "mod",
  permissions: 1_048_576, // MANAGE_ISSUES
}
const bystander: SeerrUser = {
  id: 9,
  email: "sam@example.com",
  // Display name collides with the admin's on purpose.
  displayName: "root",
  permissions: 4_194_304,
}

/** Stand-in for the host Seerr client; only the two read paths are used. */
function seerrStub(
  overrides: Partial<Pick<SeerrClient, "getIssue" | "listUsers">> = {},
): Pick<SeerrClient, "getIssue" | "listUsers"> {
  return {
    getIssue: async () => ({ createdBy: reporter }),
    listUsers: async () => [reporter, admin, moderator, bystander],
    ...overrides,
  }
}

function comment(email: string | undefined, username?: string) {
  return {
    notification_type: "ISSUE_COMMENT",
    issue: { issue_id: "42" },
    comment: {
      comment_message: "any update?",
      ...(email !== undefined ? { commentedBy_email: email } : {}),
      ...(username !== undefined ? { commentedBy_username: username } : {}),
    },
  } satisfies SeerrWebhookPayload
}

test("allows the issue reporter", async () => {
  const gate = createCommentGate(seerrStub())
  assert.equal(await gate(comment("alex@example.com", "Alex")), true)
})

test("allows ADMIN and MANAGE_ISSUES users", async () => {
  const gate = createCommentGate(seerrStub())
  assert.equal(await gate(comment("root@example.com", "root")), true)
  assert.equal(await gate(comment("mod@example.com", "mod")), true)
})

test("rejects everyone else", async () => {
  const gate = createCommentGate(seerrStub())
  assert.equal(await gate(comment("sam@example.com", "Sam")), false)
})

test("a colliding display name cannot impersonate an admin", async () => {
  const gate = createCommentGate(seerrStub())
  assert.equal(await gate(comment("sam@example.com", "root")), false)
})

test("falls back to name matching when the webhook has no email", async () => {
  const gate = createCommentGate(seerrStub())
  assert.equal(await gate(comment(undefined, "Alex")), true)
  assert.equal(await gate(comment(undefined, "mod")), true)
  assert.equal(await gate(comment(undefined, "nobody")), false)
})

test("unidentifiable authors are rejected", async () => {
  const gate = createCommentGate(seerrStub())
  assert.equal(await gate(comment(undefined, undefined)), false)
  assert.equal(
    await gate({ notification_type: "ISSUE_COMMENT", comment: {} }),
    false,
  )
})

test("empty Seerr fields do not become an identity", async () => {
  // Jellyfin-backed users often have no email: Seerr renders "", and
  // customized templates leave unknown placeholders literal.
  const gate = createCommentGate(seerrStub())
  assert.equal(await gate(comment("", "Alex")), true)
  assert.equal(await gate(comment("{{commentedBy_email}}", "Alex")), true)
  assert.equal(
    await gate(comment("{{commentedBy_email}}", "{{commentedBy_username}}")),
    false,
  )
})

test("a comment event without a usable issue id is rejected", async () => {
  const gate = createCommentGate(seerrStub())
  const payload = comment("alex@example.com", "Alex")
  assert.equal(
    await gate({ ...payload, issue: { issue_id: "{{issue_id}}" } }),
    false,
  )
})

test("fails closed when Seerr is unreachable", async () => {
  const gate = createCommentGate(
    seerrStub({
      getIssue: async () => {
        throw new Error("ECONNREFUSED")
      },
    }),
  )
  assert.equal(await gate(comment("alex@example.com", "Alex")), false)
})
