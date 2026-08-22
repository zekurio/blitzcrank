import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http"

import type { AutomationInfo, TriggerResult } from "./automations/dispatcher.ts"
import type { Config } from "./config.ts"
import { isBotComment } from "./gateways/seerr/loop-guard.ts"
import {
  isIssueEvent,
  issueIdOf,
  type SeerrWebhookPayload,
} from "./gateways/seerr/types.ts"

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

export function createApp(deps: ServerDeps): RequestListener {
  const authorized = (auth: string | undefined): boolean =>
    !deps.config.webhookSecret ||
    auth === deps.config.webhookSecret ||
    auth === `Bearer ${deps.config.webhookSecret}`

  return (request, response) => {
    handleRequest(request, response, deps, authorized).catch(
      (cause: unknown) => {
        console.error("[http] request failed:", cause)
        json(response, 500, { error: "internal server error" })
      },
    )
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ServerDeps,
  authorized: (auth: string | undefined) => boolean,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost")
  if (request.method === "GET" && url.pathname === "/healthz") {
    json(response, 200, { status: "ok", ...deps.stats() })
    return
  }
  if (request.method === "GET" && url.pathname === "/automations") {
    if (!authorized(request.headers.authorization)) {
      json(response, 401, { error: "unauthorized" })
      return
    }
    json(response, 200, { automations: deps.listAutomations() })
    return
  }

  const automation = url.pathname.match(/^\/automations\/([^/]+)\/run$/)
  if (request.method === "POST" && automation) {
    if (!authorized(request.headers.authorization)) {
      json(response, 401, { error: "unauthorized" })
      return
    }
    const name = automation[1]!
    const result = deps.triggerAutomation(name)
    if (result === "unknown") {
      json(response, 404, { error: `unknown automation ${name}` })
      return
    }
    if (result === "busy") {
      json(response, 409, { error: `${name} is already queued or running` })
      return
    }
    console.log(`[automations] manual trigger: ${name}`)
    json(response, 200, { ok: true, queued: name })
    return
  }

  if (request.method === "POST" && url.pathname === "/webhook/seerr") {
    await handleSeerrWebhook(request, response, deps, authorized)
    return
  }
  json(response, 404, { error: "not found" })
}

async function handleSeerrWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ServerDeps,
  authorized: (auth: string | undefined) => boolean,
): Promise<void> {
  if (!authorized(request.headers.authorization)) {
    json(response, 401, { error: "unauthorized" })
    return
  }

  const payload = await readPayload(request).catch(() => undefined)
  if (!payload) {
    json(response, 400, { error: "invalid JSON" })
    return
  }
  if (payload.notification_type === "TEST_NOTIFICATION") {
    console.log("[webhook] test notification received")
    json(response, 200, { ok: true, test: true })
    return
  }
  if (!isIssueEvent(payload)) {
    json(response, 200, { ok: true, ignored: "not an issue event" })
    return
  }

  const issueId = issueIdOf(payload)
  if (issueId === undefined) {
    console.warn(
      `[webhook] ${payload.notification_type} without usable issue_id; ignoring`,
    )
    json(response, 200, { ok: true, ignored: "missing issue_id" })
    return
  }
  if (payload.notification_type === "ISSUE_RESOLVED") {
    await deps.onIssueClosed(issueId)
    json(response, 200, { ok: true, ignored: "issue resolved" })
    return
  }
  if (payload.notification_type === "ISSUE_COMMENT") {
    if (isBotComment(payload, deps.config.seerrBotUsername)) {
      json(response, 200, { ok: true, ignored: "own comment" })
      return
    }
    if (!(await deps.allowComment(payload))) {
      json(response, 200, {
        ok: true,
        ignored: "comment author not authorized",
      })
      return
    }
  }

  deps.onIssueEvent(issueId, payload)
  json(response, 200, { ok: true })
}

async function readPayload(
  request: IncomingMessage,
): Promise<SeerrWebhookPayload> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  // SAFETY: Webhook fields stay optional and are sanitized before use.
  return JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as SeerrWebhookPayload
}

function json(response: ServerResponse, status: number, body: object): void {
  const content = JSON.stringify(body)
  response.writeHead(status, {
    "content-length": Buffer.byteLength(content),
    "content-type": "application/json; charset=UTF-8",
  })
  response.end(content)
}
