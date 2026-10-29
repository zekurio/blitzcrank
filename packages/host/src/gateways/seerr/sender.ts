import { Cause, Effect } from "effect"

import type { Access } from "../../gateway.ts"
import { errorKind, logEvent } from "../../log.ts"
import { USER_PAGE, type SeerrClient, type SeerrUser } from "./client.ts"
import { issueIdOf, webhookText, type SeerrWebhookPayload } from "./types.ts"

/**
 * Host-side checks of an event's sender. A new or reopened issue always
 * drives the agent, as a member's message: Seerr lets a MANAGE_ISSUES holder
 * file or reopen an issue in another user's name and keeps no trace of who
 * did, so it never shows an admin's request. A comment drives the agent only
 * if its author is the issue's reporter or a Seerr user with ADMIN or
 * MANAGE_ISSUES. Only a comment comes from an admin, and a check that cannot
 * run finds none.
 *
 * Bits from jellyseerr server/lib/permissions.ts.
 */
const ADMIN = 2
const MANAGE_ISSUES = 1_048_576

interface CommenterIdentity {
  email: string | undefined
  name: string | undefined
}

type SeerrReads = Pick<SeerrClient, "getIssueEffect" | "listUsersEffect">

export function createSenderCheckEffect(
  seerr: SeerrReads,
): (payload: SeerrWebhookPayload) => Effect.Effect<Access> {
  return (payload) =>
    payload.notification_type === "ISSUE_COMMENT"
      ? commenterEffect(seerr, payload)
      : Effect.succeed("member")
}

/**
 * A comment's author, known only by the email and name the webhook carries.
 * The issue read alone admits the reporter; the users list then only decides
 * whether they are an admin. Anyone else needs the list to be admitted at
 * all, and is denied when Seerr cannot be consulted.
 */
function commenterEffect(
  seerr: SeerrReads,
  payload: SeerrWebhookPayload,
): Effect.Effect<Access> {
  const issueId = issueIdOf(payload)
  const thread = issueId ? `seerr:${issueId}` : undefined
  return Effect.gen(function* () {
    const who: CommenterIdentity = {
      email: normalize(payload.comment?.commentedBy_email),
      name: normalize(payload.comment?.commentedBy_username),
    }
    if (issueId === undefined || (!who.email && !who.name)) {
      logEvent("comment.denied", { thread, reason: "missing_identity" }, "warn")
      return "denied"
    }

    const issue = yield* seerr.getIssueEffect(issueId)
    if (matchesUser(issue.createdBy, who)) {
      const users = yield* seerr.listUsersEffect().pipe(
        Effect.catch((error) =>
          Effect.sync((): SeerrUser[] => {
            logEvent(
              "seerr.admin_unconfirmed",
              {
                thread,
                reason: "authorization_unavailable",
                error: errorKind(error),
              },
              "warn",
            )
            return []
          }),
        ),
      )
      return soleAdmin(users, who) ? "admin" : "member"
    }

    const users = yield* seerr.listUsersEffect()
    if (soleAdmin(users, who)) return "admin"
    const commenter = users.find((user) => matchesUser(user, who))
    if (holds(commenter, ADMIN | MANAGE_ISSUES)) return "member"
    logEvent("comment.denied", { thread, reason: "not_authorized" }, "warn")
    return "denied"
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      logEvent(
        "comment.denied",
        {
          thread,
          reason: "authorization_unavailable",
          error: errorKind(Cause.squash(cause)),
        },
        "warn",
      )
      return Effect.succeed<Access>("denied")
    }),
  )
}

/**
 * Whether one account alone matches the commenter and holds ADMIN. A member
 * who took an admin's name would match too, and a full page may leave out
 * another account that matches.
 */
function soleAdmin(
  users: readonly SeerrUser[],
  who: CommenterIdentity,
): boolean {
  const matches = users.filter((user) => matchesUser(user, who))
  return (
    matches.length === 1 && users.length < USER_PAGE && holds(matches[0], ADMIN)
  )
}

function holds(user: SeerrUser | undefined, bits: number): boolean {
  return ((user?.permissions ?? 0) & bits) !== 0
}

/**
 * Identity match between a webhook comment author and a Seerr user. Email is
 * authoritative whenever both sides have one, so a renamed display name can
 * never impersonate another account; names are only compared when at least one
 * side has no email.
 */
function matchesUser(
  user: SeerrUser | undefined,
  who: CommenterIdentity,
): boolean {
  if (!user) return false
  const email = normalize(user.email)
  if (who.email && email) return who.email === email
  if (!who.name) return false
  return [user.displayName, user.username].some(
    (name) => normalize(name) === who.name,
  )
}

function normalize(value: string | undefined): string | undefined {
  return webhookText(value)?.toLowerCase()
}
