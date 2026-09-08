import { Cause, Effect } from "effect"

import { HttpRequestError } from "../../services/http.ts"
import type { SeerrClient, SeerrUser } from "../../services/seerr.ts"
import { issueIdOf, webhookText, type SeerrWebhookPayload } from "./types.ts"

/**
 * Host-side authorization for comment-triggered runs: only the issue's
 * reporter or a Seerr user with ADMIN or MANAGE_ISSUES may drive the agent
 * via comments. Fails closed (no run) when Seerr cannot be consulted.
 *
 * Bits from jellyseerr server/lib/permissions.ts.
 */
const ADMIN = 2
const MANAGE_ISSUES = 1_048_576

interface CommenterIdentity {
  email: string | undefined
  name: string | undefined
}

export function createCommentGateEffect(
  seerr: Pick<SeerrClient, "getIssueEffect" | "listUsersEffect">,
): (payload: SeerrWebhookPayload) => Effect.Effect<boolean> {
  return (payload) =>
    Effect.gen(function* () {
      const issueId = issueIdOf(payload)
      const who: CommenterIdentity = {
        email: normalize(payload.comment?.commentedBy_email),
        name: normalize(payload.comment?.commentedBy_username),
      }
      if (issueId === undefined || (!who.email && !who.name)) {
        console.warn(
          "[comment-gate] comment event without identifiable author; ignoring",
        )
        return false
      }

      const issue = yield* seerr.getIssueEffect(issueId)
      if (matchesUser(issue.createdBy, who)) return true

      const users = yield* seerr.listUsersEffect()
      const commenter = users.find((user) => matchesUser(user, who))
      const permissions = commenter?.permissions ?? 0
      const allowed = (permissions & (ADMIN | MANAGE_ISSUES)) !== 0
      if (!allowed) {
        console.warn(
          `[comment-gate] issue=${issueId} comment by "${who.email ?? who.name}"` +
            ` is neither reporter nor admin; ignoring`,
        )
      }
      return allowed
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.interrupt
        const err = Cause.squash(cause)
        console.warn(
          `[comment-gate] issue=${issueIdOf(payload)} could not verify comment author; failing closed:`,
          err instanceof Error ? err.message : err,
        )
        return Effect.succeed(false)
      }),
    )
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

export function createCommentGate(
  seerr: Pick<SeerrClient, "getIssue" | "listUsers">,
): (payload: SeerrWebhookPayload) => Promise<boolean> {
  const gate = createCommentGateEffect({
    getIssueEffect: (issueId) =>
      Effect.tryPromise({
        try: () => seerr.getIssue(issueId),
        catch: (cause) => new HttpRequestError({ cause }),
      }),
    listUsersEffect: () =>
      Effect.tryPromise({
        try: () => seerr.listUsers(),
        catch: (cause) => new HttpRequestError({ cause }),
      }),
  })
  return (payload) => Effect.runPromise(gate(payload))
}
