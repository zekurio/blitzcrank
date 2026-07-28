import { Hono } from "hono";
import type { Config } from "./config.js";
import { isIssueEvent, type SeerrWebhookPayload } from "./webhook/types.js";

export interface AutomationInfo {
  name: string;
  description: string;
  schedule: string;
  enabled: boolean;
  capabilities: string[];
  nextRun: string | undefined;
}

export interface ServerDeps {
  config: Config;
  /** Called with a validated issue event; must not throw synchronously. */
  onIssueEvent: (issueId: string, payload: SeerrWebhookPayload) => void;
  listAutomations: () => AutomationInfo[];
  /** Returns false when the automation is unknown. */
  triggerAutomation: (name: string) => boolean;
  stats: () => { queued: number; pendingRevisits: number };
}

export function createApp(deps: ServerDeps): Hono {
  const { config, onIssueEvent, stats } = deps;
  const app = new Hono();

  const authorized = (auth: string | undefined): boolean =>
    !config.webhookSecret ||
    auth === config.webhookSecret ||
    auth === `Bearer ${config.webhookSecret}`;

  app.get("/healthz", (c) => c.json({ status: "ok", ...stats() }));

  app.get("/automations", (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({ automations: deps.listAutomations() });
  });

  app.post("/automations/:name/run", (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const name = c.req.param("name");
    if (!deps.triggerAutomation(name)) {
      return c.json({ error: `unknown automation ${name}` }, 404);
    }
    console.log(`[automations] manual trigger: ${name}`);
    return c.json({ ok: true, queued: name });
  });

  app.post("/webhook/seerr", async (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let payload: SeerrWebhookPayload;
    try {
      payload = await c.req.json<SeerrWebhookPayload>();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    if (payload.notification_type === "TEST_NOTIFICATION") {
      console.log("[webhook] test notification received");
      return c.json({ ok: true, test: true });
    }

    if (!isIssueEvent(payload)) {
      return c.json({ ok: true, ignored: "not an issue event" });
    }

    // Nothing to do on resolution; our own resolutions also fire this.
    if (payload.notification_type === "ISSUE_RESOLVED") {
      return c.json({ ok: true, ignored: "issue resolved" });
    }

    // Loop guard: ignore comment events caused by the bot's own comments.
    if (
      payload.notification_type === "ISSUE_COMMENT" &&
      config.seerrBotUsername &&
      payload.comment?.commentedBy_username === config.seerrBotUsername
    ) {
      return c.json({ ok: true, ignored: "own comment" });
    }

    const issueId = payload.issue?.issue_id;
    if (issueId === undefined || issueId === null || String(issueId).length === 0) {
      console.warn(`[webhook] ${payload.notification_type} without issue_id; ignoring`);
      return c.json({ ok: true, ignored: "missing issue_id" });
    }

    console.log(`[webhook] ${payload.notification_type} issue=${issueId} subject=${payload.subject}`);
    onIssueEvent(String(issueId), payload);
    return c.json({ ok: true });
  });

  return app;
}
