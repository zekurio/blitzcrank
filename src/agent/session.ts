import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

/** Repo root (contains skills/): two levels up from dist/agent/. */
const projectRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const skillsDir = path.join(projectRoot, "skills");

export function resolveModel(modelRuntime: ModelRuntime, spec: string) {
  const slash = spec.indexOf("/");
  if (slash === -1) {
    throw new Error(`BLITZCRANK_MODEL must be "provider/model", got "${spec}"`);
  }
  const model = modelRuntime.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model) throw new Error(`Unknown model: ${spec}`);
  return model;
}

export interface AgentTurnOptions {
  modelRuntime: ModelRuntime;
  modelSpec: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  prompt: string;
  /** Persist the session transcript (JSONL) into this directory when set. */
  sessionDir: string | undefined;
  /** Receives the session file path once known, for history self-exclusion. */
  sessionFileRef: { current: string | undefined } | undefined;
  logPrefix: string;
}

/**
 * One locked-down agent turn: our skills only, our tools plus builtin `read`
 * (for SKILL.md loading), no extensions/context discovery, run to completion,
 * return the final assistant text.
 */
export async function runAgentTurn(opts: AgentTurnOptions): Promise<string> {
  const cwd = path.join(os.tmpdir(), "blitzcrank-work");
  await mkdir(cwd, { recursive: true });
  if (opts.sessionDir) await mkdir(opts.sessionDir, { recursive: true });

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
    systemPromptOverride: () => opts.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    model: resolveModel(opts.modelRuntime, opts.modelSpec),
    thinkingLevel: "medium",
    modelRuntime: opts.modelRuntime,
    resourceLoader: loader,
    customTools: opts.tools,
    tools: [...opts.tools.map((t) => t.name), "read"],
    sessionManager: opts.sessionDir
      ? SessionManager.create(cwd, opts.sessionDir)
      : SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
    }),
  });

  if (opts.sessionFileRef) opts.sessionFileRef.current = session.sessionFile;

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      console.log(`[${opts.logPrefix}] tool ${event.toolName}`, JSON.stringify(event.args));
      return;
    }
    if (event.type === "tool_execution_end" && event.isError) {
      console.warn(`[${opts.logPrefix}] tool ${event.toolName} failed`);
    }
  });

  try {
    await session.prompt(opts.prompt);

    const lastAssistant = [...session.messages]
      .reverse()
      .find((m): m is AssistantMessage => m.role === "assistant");
    if (!lastAssistant) throw new Error("agent produced no assistant message");
    if (lastAssistant.stopReason === "error") {
      throw new Error(lastAssistant.errorMessage ?? "model request failed");
    }

    return lastAssistant.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  } finally {
    unsubscribe();
    session.dispose();
  }
}
