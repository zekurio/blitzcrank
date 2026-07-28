import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import { SeerrClient } from "../services/seerr.js";
import { RunContext } from "../tools/context.js";
import { buildTools } from "../tools/index.js";
import type { SeerrWebhookPayload } from "../webhook/types.js";
import { parseDirectives, type Directives } from "./directives.js";
import { buildIssuePrompt, buildRevisitPrompt, buildSystemPrompt } from "./prompt.js";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

/** Repo root (contains skills/): two levels up from dist/agent/. */
const projectRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const skillsDir = path.join(projectRoot, "skills");

export type IssueEvent =
  | { kind: "webhook"; issueId: string; payload: SeerrWebhookPayload }
  | { kind: "revisit"; issueId: string; reason: string };

export interface RunOutcome {
  issueId: string;
  directives: Directives;
}

export class IssueRunner {
  readonly modelSpec: string;

  private constructor(
    private readonly config: Config,
    private readonly modelRuntime: ModelRuntime,
  ) {
    this.modelSpec = config.model ?? DEFAULT_MODEL;
  }

  static async create(config: Config): Promise<IssueRunner> {
    return new IssueRunner(config, await ModelRuntime.create());
  }

  private resolveModel() {
    const slash = this.modelSpec.indexOf("/");
    if (slash === -1) {
      throw new Error(`BLITZCRANK_MODEL must be "provider/model", got "${this.modelSpec}"`);
    }
    const model = this.modelRuntime.getModel(
      this.modelSpec.slice(0, slash),
      this.modelSpec.slice(slash + 1),
    );
    if (!model) throw new Error(`Unknown model: ${this.modelSpec}`);
    return model;
  }

  get commentHeader(): string {
    return `[blitzcrank w/ ${this.modelSpec}]`;
  }

  async run(event: IssueEvent): Promise<RunOutcome> {
    const { issueId } = event;
    const ctx = new RunContext();
    const seerr = new SeerrClient(this.config.seerr, this.config.seerrBotUserId);
    const tools = buildTools({
      config: this.config,
      ctx,
      seerr,
      issueId,
      commentHeader: this.commentHeader,
    });

    const cwd = path.join(os.tmpdir(), "blitzcrank-work");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: path.join(os.tmpdir(), "blitzcrank-agent-noop"),
      additionalSkillPaths: [skillsDir],
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: (current) => ({
        skills: current.skills.filter((s) => s.filePath.startsWith(skillsDir)),
        diagnostics: current.diagnostics,
      }),
      systemPromptOverride: () => buildSystemPrompt(this.config),
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd,
      model: this.resolveModel(),
      thinkingLevel: "medium",
      modelRuntime: this.modelRuntime,
      resourceLoader: loader,
      customTools: tools,
      // Service tools + read, so the agent can load SKILL.md bodies. No bash/edit/write.
      tools: [...tools.map((t) => t.name), "read"],
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
      }),
    });

    const unsubscribe = session.subscribe((sessionEvent) => {
      if (sessionEvent.type === "tool_execution_start") {
        console.log(`[agent:${issueId}] tool ${sessionEvent.toolName}`, JSON.stringify(sessionEvent.args));
      } else if (sessionEvent.type === "tool_execution_end" && sessionEvent.isError) {
        console.warn(`[agent:${issueId}] tool ${sessionEvent.toolName} failed`);
      }
    });

    try {
      const prompt =
        event.kind === "webhook"
          ? buildIssuePrompt(event.payload)
          : buildRevisitPrompt(event.issueId, event.reason);
      await session.prompt(prompt);

      const lastAssistant = [...session.messages]
        .reverse()
        .find((m): m is AssistantMessage => m.role === "assistant");
      if (!lastAssistant) throw new Error("agent produced no assistant message");
      if (lastAssistant.stopReason === "error") {
        throw new Error(lastAssistant.errorMessage ?? "model request failed");
      }

      const finalText = lastAssistant.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const directives = parseDirectives(finalText);

      if (directives.malformed) {
        console.warn(`[agent:${issueId}] malformed directive block; no comment posted:\n${finalText}`);
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
        `[agent:${issueId}] done resolve=${directives.resolve} revisit=${directives.revisitInMs ?? "-"} ` +
          `mutations=${mutations} deletes=${deletes}`,
      );
      return { issueId, directives };
    } finally {
      unsubscribe();
      session.dispose();
    }
  }
}
