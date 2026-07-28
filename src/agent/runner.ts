import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import { SeerrClient } from "../services/seerr.js";
import { RunContext } from "../tools/context.js";
import { buildIssueTools, type MediaScope, type SessionFileRef } from "../tools/index.js";
import type { SeerrWebhookPayload } from "../webhook/types.js";
import { parseDirectives, type Directives } from "./directives.js";
import { buildIssuePrompt, buildRevisitPrompt, buildSystemPrompt } from "./prompt.js";
import { runAgentTurn } from "./session.js";

export type IssueEvent =
  | { kind: "webhook"; issueId: string; payload: SeerrWebhookPayload }
  | { kind: "revisit"; issueId: string; reason: string; mediaScope: MediaScope };

export function eventMediaScope(event: IssueEvent): MediaScope {
  if (event.kind === "revisit") return event.mediaScope;
  const type = event.payload.media?.media_type;
  return type === "movie" || type === "tv" ? type : undefined;
}

export interface RunOutcome {
  issueId: string;
  directives: Directives;
}

export class IssueRunner {
  constructor(
    private readonly config: Config,
    private readonly modelRuntime: ModelRuntime,
    private readonly modelSpec: string,
  ) {}

  get commentHeader(): string {
    return `[blitzcrank w/ ${this.modelSpec}]`;
  }

  async run(event: IssueEvent): Promise<RunOutcome> {
    const { issueId } = event;
    const ctx = new RunContext();
    const seerr = new SeerrClient(this.config.seerr, this.config.seerrBotUserId);
    const sessionFileRef: SessionFileRef = { current: undefined };

    const finalText = await runAgentTurn({
      modelRuntime: this.modelRuntime,
      modelSpec: this.modelSpec,
      systemPrompt: buildSystemPrompt(this.config),
      tools: buildIssueTools({
        config: this.config,
        ctx,
        seerr,
        issueId,
        commentHeader: this.commentHeader,
        sessionFileRef,
        mediaScope: eventMediaScope(event),
      }),
      prompt:
        event.kind === "webhook"
          ? buildIssuePrompt(event.payload)
          : buildRevisitPrompt(event.issueId, event.reason),
      sessionDir: path.join(this.config.dataDir, "sessions", "issues"),
      sessionFileRef,
      logPrefix: `issue:${issueId}`,
    });

    const directives = parseDirectives(finalText);

    if (directives.malformed) {
      console.warn(`[issue:${issueId}] malformed directive block; no comment posted:\n${finalText}`);
    } else {
      if (directives.comment) {
        await seerr.postComment(issueId, `${this.commentHeader}\n\n${directives.comment}`);
      }
      if (directives.resolve) {
        await seerr.setStatus(issueId, "resolved");
      }
    }

    const { mutations, deletes } = ctx.counts;
    console.log(
      `[issue:${issueId}] done resolve=${directives.resolve} revisit=${directives.revisitInMs ?? "-"} ` +
        `mutations=${mutations} deletes=${deletes}`,
    );
    return { issueId, directives };
  }
}
