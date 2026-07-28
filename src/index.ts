import { serve } from "@hono/node-server";
import { IssueRunner, type IssueEvent } from "./agent/runner.js";
import { loadConfig } from "./config.js";
import { SerialQueue } from "./queue.js";
import { RevisitScheduler } from "./revisits.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const runner = await IssueRunner.create(config);
  const queue = new SerialQueue();
  const revisits = new RevisitScheduler();

  const enqueue = (event: IssueEvent): void => {
    queue.enqueue(async () => {
      const { issueId, directives } = await runner.run(event);
      if (directives.revisitInMs !== undefined && directives.revisitReason) {
        const reason = directives.revisitReason;
        console.log(`[revisit] issue=${issueId} in ${Math.round(directives.revisitInMs / 60000)}m: ${reason}`);
        revisits.schedule(issueId, directives.revisitInMs, () =>
          enqueue({ kind: "revisit", issueId, reason }),
        );
      }
    });
  };

  const app = createApp({
    config,
    onIssueEvent: (issueId, payload) => {
      // New user activity supersedes any scheduled follow-up for this issue.
      revisits.cancel(issueId);
      enqueue({ kind: "webhook", issueId, payload });
    },
    stats: () => ({ queued: queue.size, pendingRevisits: revisits.pending }),
  });

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    const services = ["sonarr", "radarr", "sabnzbd", "jellyfin", "anvil"] as const;
    const enabled = services.filter((s) => config[s]);
    console.log(`blitzcrank listening on :${info.port}`);
    console.log(`  webhook: POST /webhook/seerr`);
    console.log(`  model: ${runner.modelSpec}`);
    console.log(`  services: seerr${enabled.length ? ", " + enabled.join(", ") : ""}`);
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
