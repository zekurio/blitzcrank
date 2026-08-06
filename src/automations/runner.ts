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
import { modelSpecForAutomation } from "./models.js"
import { buildAutomationSystemPrompt } from "./prompt.js"
import {
  buildAutomationReportTool,
  parseAutomationReport,
  type AutomationReportCapture,
  type AutomationStatus,
} from "./report.js"

export type { AutomationStatus } from "./report.js"

export interface AutomationReport {
  name: string
  status: AutomationStatus
  body: string
  /** True when the run produced no report body (nothing to do). */
  empty: boolean
  /** True when the run did not finish with one valid structured report. */
  malformed: boolean
  /** Successful read-only custom and builtin tool calls. */
  reads: number
  mutations: number
  deletes: number
  /**
   * `RunUsage.newTokens`: input + cache writes + output, no cache reads. This
   * one reaches a human through the Discord report, so it has to track the work
   * done rather than how often the context was re-read.
   */
  tokens: number
}

export class AutomationRunner {
  constructor(
    private readonly config: Config,
    private readonly modelRuntime: ModelRuntime,
    private readonly defaultModelSpec: string,
    private readonly modelSpecs: Readonly<Record<string, string>>,
  ) {}

  async run(def: AutomationDefinition): Promise<AutomationReport> {
    // Both are usually undefined, meaning no ceiling. An automation is bounded
    // by the capability allowlist below and by the evidence gates; a budget is
    // an extra brake an operator can write into one definition's frontmatter.
    const ctx = new RunContext({
      limits: {
        maxMutations: def.mutationBudget,
        maxDeletes: def.deletionBudget,
      },
    })
    const sessionFileRef: SessionFileRef = { current: undefined }
    const modelSpec = modelSpecForAutomation(
      def.name,
      this.defaultModelSpec,
      this.modelSpecs,
    )

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
    const reportCapture: AutomationReportCapture = { submissions: [] }
    tools.push(buildAutomationReportTool(reportCapture))
    const readTools = new Set([
      "read",
      ...tools.filter((tool) => isReadTool(tool.name)).map((tool) => tool.name),
    ])
    const reads = { count: 0 }

    const turn = await runAgentTurn({
      modelRuntime: this.modelRuntime,
      modelSpec,
      systemPrompt: buildAutomationSystemPrompt(this.config, def),
      tools,
      prompt: def.body,
      sessionDir: path.join(this.config.dataDir, "sessions", "automations"),
      // Automations never resume: each tick is a fresh sweep of current state,
      // and carrying last hour's conclusions into it would be a liability.
      resumeFile: undefined,
      sessionFileRef,
      onToolExecutionEnd: (toolName, isError) => {
        if (!isError && readTools.has(toolName)) reads.count += 1
      },
      logPrefix: `automation:${def.name}`,
    })

    const report: AutomationReport = {
      name: def.name,
      ...parseAutomationReport(reportCapture, turn.finalToolNames),
      reads: reads.count,
      mutations: ctx.counts.mutations,
      deletes: ctx.counts.deletes,
      tokens: turn.usage.newTokens,
    }
    const log = report.status === "fehler" ? console.error : console.log
    log(
      `[automation:${def.name}] status=${report.status} reads=${report.reads} ` +
        `mutations=${report.mutations} deletes=${report.deletes} tokens=${report.tokens} ` +
        `billed=${turn.usage.billedTokens} model=${modelSpec}` +
        `${report.malformed ? " (invalid structured report)" : ""}${report.empty ? " (no report)" : ""}` +
        `${report.body ? `\n${report.body}` : ""}`,
    )
    return report
  }
}
