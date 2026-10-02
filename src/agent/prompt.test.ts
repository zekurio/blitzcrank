import assert from "node:assert/strict"
import test from "node:test"

import { emptyCase } from "../casefile.ts"
import { discordSystemPrompt } from "../discord/agent.ts"
import {
  buildIssuePrompt,
  buildRevisitPrompt,
  buildSystemPrompt,
  SERVICE_EVIDENCE_RULES,
} from "./prompt.ts"

const noWeb = { search: undefined, extract: undefined }

test("issue events select the current message without repeating webhook internals", () => {
  const file = emptyCase("42")
  const payload = {
    notification_type: "ISSUE_COMMENT",
    subject: "The movie",
    message: "Original report, not the follow-up",
    comment: {
      comment_message: "Please check again",
      commentedBy_email: "private@example.test",
    },
    media: { tmdbId: 999 },
  }
  const prompt = buildIssuePrompt(payload, "LIVE ISSUE", file, 2, false)
  assert.match(prompt, /authorized follow-up/)
  assert.match(prompt, /Please check again/)
  assert.match(prompt, /LIVE ISSUE/)
  assert.match(prompt, /Follow-ups remaining: 2/)
  assert.doesNotMatch(prompt, /Original report|private@example|999/)
  assert.doesNotMatch(
    buildIssuePrompt(
      { ...payload, comment: { comment_message: "{{comment_message}}" } },
      "LIVE ISSUE",
      file,
      2,
      false,
    ),
    /Original report|comment_message/,
  )
  assert.match(
    buildIssuePrompt(
      { ...payload, notification_type: "ISSUE_CREATED" },
      "LIVE ISSUE",
      file,
      2,
      false,
    ),
    /Original report/,
  )
})

test("only fresh issue sessions get fallback notes; revisits carry current state", () => {
  const file = emptyCase("42")
  file.summary.facts.push("earlier investigation")
  file.spend.deletes = 3
  const payload = { notification_type: "ISSUE_COMMENT" }
  assert.match(
    buildIssuePrompt(payload, "LIVE ISSUE", file, 0, false),
    /earlier investigation/,
  )
  const resumed = buildIssuePrompt(payload, "LIVE ISSUE", file, 0, true)
  assert.doesNotMatch(resumed, /earlier investigation/)
  assert.match(resumed, /deletions: 3/)
  assert.match(resumed, /Follow-ups remaining: 0/)
  const revisit = buildRevisitPrompt(
    "42",
    "Verify the import",
    "FRESH ISSUE",
    file,
    1,
    true,
  )
  assert.match(revisit, /not a new user request/)
  assert.match(revisit, /Verify the import/)
  assert.match(revisit, /FRESH ISSUE/)
  assert.doesNotMatch(revisit, /earlier investigation/)
})

test("issue capability guidance follows registered tools, not configured services", () => {
  const prompt = buildSystemPrompt({ language: "German" }, noWeb, [])
  assert.doesNotMatch(prompt, /`media_probe`|`media_frames`|`anvil_retry_job`/)
  assert.match(prompt, /external availability cannot be checked/)
  assert.match(prompt, /Establish the full extent before changing anything/)
  assert.match(prompt, /Act on exactly the verified set/)
  const capable = buildSystemPrompt(
    { language: "German" },
    { search: "web_search", extract: "web_extract" },
    ["media_probe", "media_frames", "anvil_retry_job", "anvil_status"],
  )
  assert.match(capable, /`media_probe`/)
  assert.match(capable, /`media_frames`/)
  assert.match(capable, /`anvil_retry_job`/)
  assert.match(capable, /`web_search`/)
})

test("issue and Discord prompts share service source selection without weakening approval", () => {
  const issue = buildSystemPrompt({ language: "German" }, noWeb, [])
  const answer = discordSystemPrompt("German", noWeb, "answer")
  const thread = discordSystemPrompt("German", noWeb, "thread")
  for (const prompt of [issue, answer, thread]) {
    assert.ok(prompt.includes(SERVICE_EVIDENCE_RULES))
    assert.match(prompt, /release candidates and rejection reasons/)
    assert.match(prompt, /A failed service makes only that source unknown/)
  }
  assert.match(answer, /read-only access/)
  assert.match(answer, /do not investigate/)
  assert.match(thread, /exact scope was already approved in this conversation/)
  assert.match(thread, /do not mutate/)
  assert.match(thread, /Diagnostic requests do not authorize mutation/)
})
