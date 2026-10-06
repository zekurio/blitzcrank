import { randomUUID } from "node:crypto"
import path from "node:path"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import { SdkError } from "../agent/effect.ts"
import { resolveModel, runAgentTurnEffect } from "../agent/session.ts"
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
  AUTOMATION_REPORT_TOOL,
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

  runEffect(def: AutomationDefinition, runId: string = randomUUID()) {
    return Effect.gen({ self: this }, function* () {
      const ctx = new RunContext()
      const sessionFileRef: SessionFileRef = { current: undefined }
      const modelSpec = modelSpecForAutomation(
        def.name,
        this.defaultModelSpec,
        this.modelSpecs,
      )

      const serviceTools = buildServiceTools(
        this.config,
        ctx,
        sessionFileRef,
        resolveModel(this.modelRuntime, modelSpec).input,
      )
      for (const name of def.mutationTools) {
        const tool = serviceTools.find((candidate) => candidate.name === name)
        if (!tool) {
          return yield* Effect.fail(
            new SdkError({
              cause: undefined,
              message:
                `automation ${def.name} requires unknown or unavailable ` +
                `mutation tool ${name}`,
            }),
          )
        }
        if (isReadTool(tool.name)) {
          return yield* Effect.fail(
            new SdkError({
              cause: undefined,
              message:
                `automation ${def.name} lists read tool ${name} in ` +
                "mutation_tools; reads are always available",
            }),
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
        ...tools
          .filter((tool) => isReadTool(tool.name))
          .map((tool) => tool.name),
      ])
      const turn = yield* runAgentTurnEffect({
        modelRuntime: this.modelRuntime,
        modelSpec,
        systemPrompt: buildAutomationSystemPrompt(this.config, def),
        tools,
        terminalToolNames: [AUTOMATION_REPORT_TOOL],
        prompt: def.body,
        storageFile: path.join(
          this.config.dataDir,
          "sessions",
          "automations",
          `${encodeURIComponent(runId)}.sqlite`,
        ),
        // A recovered tick resumes its own submission. A new tick always gets a
        // new database and cannot inherit the previous sweep's conclusions.
        requestId: runId,
        runContext: ctx,
        sessionFileRef,
        logPrefix: `automation:${def.name}`,
      })
      if (turn.failure)
        return yield* Effect.fail(
          new SdkError({ message: turn.failure.message, cause: turn.failure }),
        )
      // Completion can be recovered without invoking the terminal tool again.
      // Its committed result, not the current process's capture, is authoritative.
      reportCapture.submissions = turn.terminalToolResults.flatMap((result) => {
        const details = result.details
        if (
          result.toolName !== AUTOMATION_REPORT_TOOL ||
          details === null ||
          typeof details !== "object" ||
          !("status" in details) ||
          !("body" in details) ||
          typeof details.body !== "string" ||
          (details.status !== "ok" &&
            details.status !== "warnung" &&
            details.status !== "fehler")
        )
          return []
        return [{ status: details.status, body: details.body }]
      })

      const report: AutomationReport = {
        name: def.name,
        ...parseAutomationReport(reportCapture, turn.finalToolNames),
        reads: Object.entries(turn.successfulToolCounts).reduce(
          (count, [name, calls]) => count + (readTools.has(name) ? calls : 0),
          0,
        ),
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
    })
  }
}
