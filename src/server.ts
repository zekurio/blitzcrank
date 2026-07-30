import { Hono } from "hono"

import type { AutomationInfo, TriggerResult } from "./automations/dispatcher.js"
import type { Config } from "./config.js"
import { isBotComment } from "./webhook/loop-guard.js"
import {
  isIssueEvent,
  issueIdOf,
  type SeerrWebhookPayload,
} from "./webhook/types.js"

export interface ServerDeps {
  config: Config
  /** Called with a validated issue event; must not throw synchronously. */
  onIssueEvent: (issueId: string, payload: SeerrWebhookPayload) => void
  /** Called when an issue is resolved, so pending follow-ups are dropped. */
  onIssueClosed: (issueId: string) => Promise<void>
  /** Authorizes comment-triggered runs (reporter/admin policy). */
  allowComment: (payload: SeerrWebhookPayload) => Promise<boolean>
  listAutomations: () => AutomationInfo[]
  triggerAutomation: (name: string) => TriggerResult
  stats: () => { queued: number; pendingRevisits: number }
}

export function createApp(deps: ServerDeps): Hono {
  const { config, onIssueEvent, stats } = deps
  const app = new Hono()

  const authorized = (auth: string | undefined): boolean =>
    !config.webhookSecret ||
    auth === config.webhookSecret ||
    auth === `Bearer ${config.webhookSecret}`

  app.get("/healthz", (c) => c.json({ status: "ok", ...stats() }))

  app.get("/automations", (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401)
    }
    return c.json({ automations: deps.listAutomations() })
  })

  app.post("/automations/:name/run", (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401)
    }
    const name = c.req.param("name")
    const result = deps.triggerAutomation(name)
    if (result === "unknown") {
      return c.json({ error: `unknown automation ${name}` }, 404)
    }
    if (result === "busy") {
      return c.json({ error: `${name} is already queued or running` }, 409)
    }
    console.log(`[automations] manual trigger: ${name}`)
    return c.json({ ok: true, queued: name })
  })

  app.post("/webhook/seerr", async (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401)
    }

    let payload: SeerrWebhookPayload
    try {
      payload = await c.req.json<SeerrWebhookPayload>()
    } catch {
      return c.json({ error: "invalid JSON" }, 400)
    }

    if (payload.notification_type === "TEST_NOTIFICATION") {
      console.log("[webhook] test notification received")
      return c.json({ ok: true, test: true })
    }

    if (!isIssueEvent(payload)) {
      return c.json({ ok: true, ignored: "not an issue event" })
    }

    // Seerr renders issue_id as a numeric string; anything else means a broken
    // or customized template, not an issue we can act on.
    const issueId = issueIdOf(payload)
    if (issueId === undefined) {
      console.warn(
        `[webhook] ${payload.notification_type} without usable issue_id; ignoring`,
      )
      return c.json({ ok: true, ignored: "missing issue_id" })
    }

    // No run on resolution (our own resolutions fire this too), but a resolved
    // issue must not be woken later by a follow-up that is still armed.
    if (payload.notification_type === "ISSUE_RESOLVED") {
      await deps.onIssueClosed(issueId)
      return c.json({ ok: true, ignored: "issue resolved" })
    }

    if (payload.notification_type === "ISSUE_COMMENT") {
      // Loop guard: ignore comment events caused by the bot's own comments.
      if (isBotComment(payload, config.seerrBotUsername)) {
        return c.json({ ok: true, ignored: "own comment" })
      }
      // Authorization gate. Runs before onIssueEvent so an unauthorized
      // comment neither starts a run nor cancels a pending revisit.
      if (!(await deps.allowComment(payload))) {
        return c.json({ ok: true, ignored: "comment author not authorized" })
      }
    }

    console.log(
      `[webhook] ${payload.notification_type} issue=${issueId} subject=${payload.subject}`,
    )
    onIssueEvent(issueId, payload)
    return c.json({ ok: true })
  })

  return app
}
