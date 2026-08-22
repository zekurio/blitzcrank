import path from "node:path"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

import { runAgentTurn } from "../agent/session.ts"
import type { Config } from "../config.ts"
import { RunContext } from "../tools/context.ts"
import {
  buildServiceTools,
  isReadTool,
  type SessionFileRef,
} from "../tools/index.ts"
import type { AutomationDefinition } from "./definitions.ts"
import { modelSpecForAutomation } from "./models.ts"
import { buildAutomationSystemPrompt } from "./prompt.ts"
import {
  buildAutomationReportTool,
  parseAutomationReport,
  type AutomationReportCapture,
  type AutomationStatus,
} from "./report.ts"

export type { AutomationStatus } from "./report.ts"

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
    const ctx = new RunContext()
    const sessionFileRef: SessionFileRef = { current: undefined }
    const modelSpec = modelSpecForAutomation(
      def.name,
      this.defaultModelSpec,
      this.modelSpecs,
    )

    const serviceTools = buildServiceTools(this.config, ctx, sessionFileRef)
    for (const name of def.mutationTools) {
      const tool = serviceTools.find((candidate) => candidate.name === name)
      if (!tool) {
        throw new Error(
          `automation ${def.name} requires unknown or unavailable ` +
            `mutation tool ${name}`,
        )
      }
      if (isReadTool(tool.name)) {
        throw new Error(
          `automation ${def.name} lists read tool ${name} in ` +
            "mutation_tools; reads are always available",
        )
      }
    }
    const allowedMutations = new Set(def.mutationTools)
    const tools = serviceTools.filter(
      (tool) => isReadTool(tool.name) || allowedMutations.has(tool.name),
    )
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
