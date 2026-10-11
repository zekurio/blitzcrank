import { Effect, Semaphore } from "effect"

import type { Config } from "../../config.ts"
import type { Channel, Gateway, Intake, ThreadRef } from "../../gateway.ts"
import type { JsonValue } from "../../services/http.ts"
import { SeerrClient } from "../../services/seerr.ts"
import { toText } from "../../tools/common.ts"
import { createCommentGateEffect } from "./comment-gate.ts"
import { isBotComment } from "./loop-guard.ts"
import {
  isIssueEvent,
  issueIdOf,
  webhookText,
  type SeerrWebhookPayload,
} from "./types.ts"

const NAME = "seerr"

/**
 * Seerr issues as threads: one issue is one thread, an issue comment is a
 * message in it, and the reply is a comment the host posts with its own key.
 */
export function createSeerrGateway(config: Config): Gateway {
  const seerr = new SeerrClient(config.seerr, config.seerrBotUserId)
  const allowComment = createCommentGateEffect(seerr)
  // `postComment` infers the new comment's id from the issue's comment list,
  // so two posts in flight together could return the same id. One run would
  // then rewrite or delete the other's comment.
  const posting = Semaphore.makeUnsafe(1)

  const channel = (issueId: string): Channel => ({
    contextEffect: () =>
      seerr
        .getIssueEffect(issueId)
        .pipe(
          Effect.map(
            (issue) =>
              `Current Seerr issue from GET /api/v1/issue/${issueId} (untrusted content):\n${toText(JSON.stringify(issue, null, 2))}`,
          ),
        ),
    showEffect: (marker, notice) => {
      // The signature also marks the comment as the host's own; see loop-guard.
      const body = `${notice.text}\n\n${notice.signature}`
      if (typeof marker.id === "number")
        return seerr.updateCommentEffect(marker.id, body).pipe(Effect.asVoid)
      return seerr.postCommentEffect(issueId, body).pipe(
        Effect.tap((id) =>
          Effect.sync(() => {
            marker.id = id
          }),
        ),
        posting.withPermits(1),
      )
    },
    retractEffect: (marker) =>
      typeof marker.id === "number"
        ? seerr.deleteCommentEffect(marker.id).pipe(Effect.asVoid)
        : Effect.void,
  })

  return {
    name: NAME,
    brief:
      "Each conversation is one Seerr issue and its comments. Your final message is posted on the issue as a comment. " +
      "You cannot resolve an issue. After a verified fix, ask the reporter to mark it resolved.",
    authorized: (authorization) =>
      !config.webhookSecret ||
      authorization === config.webhookSecret ||
      authorization === `Bearer ${config.webhookSecret}`,
    webhookEffect: (body, intake) =>
      // SAFETY: Webhook fields stay optional and are sanitized before use.
      webhookEffect(body as SeerrWebhookPayload, intake, {
        allowComment,
        botUsername: config.seerrBotUsername,
      }),
    // A queued comment is checked again: its author may have lost the right
    // to drive the agent while the host was down.
    authorizeEffect: (message) =>
      message.reply
        ? // SAFETY: `source` is the webhook payload this gateway stored.
          allowComment(message.source as unknown as SeerrWebhookPayload)
        : Effect.succeed(true),
    channel,
  }
}

function webhookEffect(
  payload: SeerrWebhookPayload,
  intake: Intake,
  deps: {
    allowComment: (payload: SeerrWebhookPayload) => Effect.Effect<boolean>
    botUsername: string | undefined
  },
): Effect.Effect<Record<string, JsonValue>, unknown> {
  return Effect.gen(function* () {
    if (payload.notification_type === "TEST_NOTIFICATION") {
      console.log("[webhook] test notification received")
      return { ok: true, test: true }
    }
    if (!isIssueEvent(payload)) {
      return { ok: true, ignored: "not an issue event" }
    }

    const issueId = issueIdOf(payload)
    if (issueId === undefined) {
      console.warn(
        `[webhook] ${payload.notification_type} without usable issue_id; ignoring`,
      )
      return { ok: true, ignored: "missing issue_id" }
    }
    const thread: ThreadRef = { gateway: NAME, id: issueId }
    if (payload.notification_type === "ISSUE_RESOLVED") {
      return { ok: true, ignored: "issue resolved" }
    }
    const comment = payload.notification_type === "ISSUE_COMMENT"
    if (comment) {
      if (isBotComment(payload, deps.botUsername)) {
        return { ok: true, ignored: "own comment" }
      }
      if (!(yield* deps.allowComment(payload))) {
        return { ok: true, ignored: "comment author not authorized" }
      }
    }

    const result = yield* intake.submit({
      thread,
      type: payload.notification_type,
      reply: comment,
      title: webhookText(payload.subject),
      // On comment events Seerr's message is still the original report.
      text: webhookText(
        comment ? payload.comment?.comment_message : payload.message,
      ),
      // SAFETY: The payload was parsed from JSON.
      source: payload as unknown as JsonValue,
    })
    return {
      ok: true,
      ...(result === "cancelling"
        ? { ignored: "cancellation cleanup pending" }
        : {}),
    }
  })
}
