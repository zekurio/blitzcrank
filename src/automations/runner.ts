import path from "node:path"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

import { runAgentTurn } from "../agent/session.js"
import type { Config } from "../config.js"
import { RunContext } from "../tools/context.js"
import {
  buildServiceTools,
  isReadTool,
  type SessionFileRef,
} from "../tools/index.js"
import { capabilityTools, type AutomationDefinition } from "./definitions.js"
import { buildAutomationSystemPrompt } from "./prompt.js"

export type AutomationStatus = "ok" | "warnung" | "fehler"

export interface AutomationReport {
  name: string
  status: AutomationStatus
  body: string
  /** True when the run produced no report body (nothing to do). */
  empty: boolean
  /** True when the output did not follow the STATUS protocol. */
  malformed: boolean
}

export function parseAutomationOutput(
  text: string,
): Omit<AutomationReport, "name"> {
  const trimmed = text.trim()
  if (trimmed === "")
    return { status: "ok", body: "", empty: true, malformed: false }

  const lines = trimmed.split("\n")
  const status = lines[0]!.trim().match(/^STATUS:\s*(ok|warnung|fehler)\s*$/i)
  if (!status)
    return { status: "fehler", body: trimmed, empty: false, malformed: true }

  const body = lines.slice(1).join("\n").trim()
  return {
    status: status[1]!.toLowerCase() as AutomationStatus,
    body,
    empty: body === "",
    malformed: false,
  }
}

export class AutomationRunner {
  constructor(
    private readonly config: Config,
    private readonly modelRuntime: ModelRuntime,
    private readonly modelSpec: string,
  ) {}

  async run(def: AutomationDefinition): Promise<AutomationReport> {
    const ctx = new RunContext({
      maxMutations: def.mutationBudget,
      maxDeletes: def.deletionBudget,
    })
    const sessionFileRef: SessionFileRef = { current: undefined }

    const allowedMutations = capabilityTools(def.capabilities)
    const tools = buildServiceTools(this.config, ctx, sessionFileRef).filter(
      (tool) => isReadTool(tool.name) || allowedMutations.includes(tool.name),
    )
    for (const name of allowedMutations) {
      if (!tools.some((tool) => tool.name === name)) {
        throw new Error(
          `automation ${def.name} requires tool ${name}, but its service is not configured`,
        )
      }
    }

    const turn = await runAgentTurn({
      modelRuntime: this.modelRuntime,
      modelSpec: this.modelSpec,
      systemPrompt: buildAutomationSystemPrompt(this.config, def),
      tools,
      prompt: def.body,
      sessionDir: path.join(this.config.dataDir, "sessions", "automations"),
      sessionFileRef,
      logPrefix: `automation:${def.name}`,
    })

    const report: AutomationReport = {
      name: def.name,
      ...parseAutomationOutput(turn.text),
    }
    const { mutations, deletes } = ctx.counts
    const log = report.status === "fehler" ? console.error : console.log
    log(
      `[automation:${def.name}] status=${report.status} mutations=${mutations} deletes=${deletes} ` +
        `tokens=${turn.usage.newTokens} billed=${turn.usage.billedTokens}` +
        `${report.malformed ? " (malformed output)" : ""}${report.empty ? " (no report)" : ""}` +
        `${report.body ? `\n${report.body}` : ""}`,
    )
    return report
  }
}
