import { Hono } from "hono";
import type { Config } from "./config.js";
import { isIssueEvent, type SeerrWebhookPayload } from "./webhook/types.js";

export interface ServerDeps {
  config: Config;
  /** Called with a validated issue event; must not throw synchronously. */
  onIssueEvent: (issueId: string, payload: SeerrWebhookPayload) => void;
  stats: () => { queued: number; pendingRevisits: number };
}

export function createApp({ config, onIssueEvent, stats }: ServerDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok", ...stats() }));

  app.post("/webhook/seerr", async (c) => {
    if (config.webhookSecret) {
      const auth = c.req.header("authorization");
      if (auth !== config.webhookSecret && auth !== `Bearer ${config.webhookSecret}`) {
        return c.json({ error: "unauthorized" }, 401);
      }
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
