import { serve } from "@hono/node-server";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { eventMediaScope, IssueRunner, type IssueEvent } from "./agent/runner.js";
import { DEFAULT_MODEL } from "./agent/session.js";
import { loadAutomations, type AutomationDefinition } from "./automations/definitions.js";
import { AutomationRunner } from "./automations/runner.js";
import { AutomationScheduler } from "./automations/scheduler.js";
import { loadConfig } from "./config.js";
import { SerialQueue } from "./queue.js";
import { RevisitScheduler } from "./revisits.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const modelSpec = config.model ?? DEFAULT_MODEL;
  const modelRuntime = await ModelRuntime.create();

  const issueRunner = new IssueRunner(config, modelRuntime, modelSpec);
  const automationRunner = new AutomationRunner(config, modelRuntime, modelSpec);
  const automations = await loadAutomations(config.automationsDir);

  const queue = new SerialQueue();
  const revisits = new RevisitScheduler();

  const enqueueIssue = (event: IssueEvent): void => {
    queue.enqueue(async () => {
      const { issueId, directives } = await issueRunner.run(event);
      if (directives.revisitInMs !== undefined && directives.revisitReason) {
        const reason = directives.revisitReason;
        console.log(`[revisit] issue=${issueId} in ${Math.round(directives.revisitInMs / 60000)}m: ${reason}`);
        const mediaScope = eventMediaScope(event);
        revisits.schedule(issueId, directives.revisitInMs, () =>
          enqueueIssue({ kind: "revisit", issueId, reason, mediaScope }),
        );
      }
    });
  };

  const enqueueAutomation = (def: AutomationDefinition): void => {
    queue.enqueue(async () => {
      await automationRunner.run(def);
    });
  };

  const scheduler = new AutomationScheduler(enqueueAutomation);
  scheduler.start(automations);

  const app = createApp({
    config,
    onIssueEvent: (issueId, payload) => {
      // New user activity supersedes any scheduled follow-up for this issue.
      revisits.cancel(issueId);
      enqueueIssue({ kind: "webhook", issueId, payload });
    },
    listAutomations: () =>
      automations.map((def) => ({
        name: def.name,
        description: def.description,
        schedule: def.schedule,
        enabled: def.enabled,
        capabilities: def.capabilities,
        nextRun: scheduler.nextRun(def.name),
      })),
    triggerAutomation: (name) => {
      const def = automations.find((d) => d.name === name);
      if (!def) return false;
      enqueueAutomation(def);
      return true;
    },
    stats: () => ({ queued: queue.size, pendingRevisits: revisits.pending }),
  });

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    const services = ["sonarr", "radarr", "sabnzbd", "jellyfin", "anvil"] as const;
    const enabled = services.filter((s) => config[s]);
    console.log(`blitzcrank listening on :${info.port}`);
    console.log(`  webhook: POST /webhook/seerr`);
    console.log(`  model: ${modelSpec}`);
    console.log(`  services: seerr${enabled.length ? ", " + enabled.join(", ") : ""}`);
    for (const def of automations) {
      console.log(
        `  automation: ${def.name} (${def.schedule}${def.enabled ? "" : ", disabled"})` +
          ` next=${scheduler.nextRun(def.name) ?? "-"}`,
      );
    }
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
