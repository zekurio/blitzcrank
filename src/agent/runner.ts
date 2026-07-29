import path from "node:path"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

import { CaseStore, clampEntry, type CaseFile } from "../casefile.js"
import type { Config } from "../config.js"
import { planRevisit } from "../revisits.js"
import { SeerrClient } from "../services/seerr.js"
import { RunContext } from "../tools/context.js"
import {
  buildIssueTools,
  type MediaScope,
  type SessionFileRef,
  type StatusComment,
} from "../tools/index.js"
import type { SeerrWebhookPayload } from "../webhook/types.js"
import { parseDirectives, type Directives } from "./directives.js"
import {
  buildIssuePrompt,
  buildRevisitPrompt,
  buildSystemPrompt,
} from "./prompt.js"
import { modelAnchor, runAgentTurn, usageAnchor } from "./session.js"

export type IssueEvent =
  | { kind: "webhook"; issueId: string; payload: SeerrWebhookPayload }
  | { kind: "revisit"; issueId: string; reason: string; mediaScope: MediaScope }

export function eventMediaScope(event: IssueEvent): MediaScope {
  if (event.kind === "revisit") return event.mediaScope
  const type = event.payload.media?.media_type
  return type === "movie" || type === "tv" ? type : undefined
}

export interface RunOutcome {
  issueId: string
  directives: Directives
  /** The case file as persisted, including the revisit the host armed. */
  casefile: CaseFile
}

const noDirectives = (): Directives => ({
  resolve: false,
  revisitInMs: undefined,
  revisitReason: undefined,
  comment: "",
  malformed: false,
})

/**
 * Pre-run gate: an issue at its ceiling never starts a session, and says so
 * exactly once. Pure so the decision is testable without a model.
 */
export function budgetStop(
  casefile: CaseFile,
  budgetUsd: number,
): { skip: boolean; notify: boolean } {
  const skip = budgetUsd > 0 && casefile.spend.cost >= budgetUsd
  return { skip, notify: skip && !casefile.budgetNotified }
}

export class IssueRunner {
  private readonly cases: CaseStore

  constructor(
    private readonly config: Config,
    private readonly modelRuntime: ModelRuntime,
    private readonly modelSpec: string,
  ) {
    this.cases = new CaseStore(path.join(config.dataDir, "cases"))
  }

  get anchor(): string {
    return modelAnchor(this.modelSpec)
  }

  async run(event: IssueEvent): Promise<RunOutcome> {
    const { issueId } = event
    const seerr = new SeerrClient(this.config.seerr, this.config.seerrBotUserId)
    const casefile = await this.cases.load(issueId)
    const budget = this.config.issueBudgetUsd

    // Enforced before the spend: an exhausted issue never starts a session.
    const stop = budgetStop(casefile, budget)
    if (stop.skip) {
      console.warn(
        `[issue:${issueId}] budget exhausted ($${casefile.spend.cost.toFixed(2)} of $${budget.toFixed(2)}); skipping run`,
      )
      if (stop.notify) await seerr.postComment(issueId, this.budgetComment())
      casefile.budgetNotified = true
      // Never leave a follow-up armed for an issue that can no longer run.
      casefile.revisit = undefined
      await this.cases.save(casefile)
      return { issueId, directives: noDirectives(), casefile }
    }

    const ctx = new RunContext()
    const sessionFileRef: SessionFileRef = { current: undefined }
    // The agent's progress tool posts this once and edits it in place; the
    // final comment then overwrites it, so a run leaves one comment at most.
    const status: StatusComment = { id: undefined }
    const revisitsLeft = Math.max(
      0,
      this.config.maxRevisitChain -
        (event.kind === "revisit" ? (casefile.revisit?.chain ?? 0) : 0),
    )

    const turn = await runAgentTurn({
      modelRuntime: this.modelRuntime,
      modelSpec: this.modelSpec,
      systemPrompt: buildSystemPrompt(this.config),
      tools: buildIssueTools({
        config: this.config,
        ctx,
        seerr,
        issueId,
        anchor: this.anchor,
        sessionFileRef,
        mediaScope: eventMediaScope(event),
        status,
        casefile,
      }),
      prompt:
        event.kind === "webhook"
          ? buildIssuePrompt(event.payload, casefile, revisitsLeft)
          : buildRevisitPrompt(
              event.issueId,
              event.reason,
              casefile,
              revisitsLeft,
            ),
      sessionDir: path.join(this.config.dataDir, "sessions", "issues"),
      sessionFileRef,
      logPrefix: `issue:${issueId}`,
      ...(budget > 0
        ? { costCeiling: budget, costSpent: casefile.spend.cost }
        : {}),
    })

    // Spend is recorded before any Seerr call: a failure while commenting must
    // not make an expensive run invisible to the budget.
    const { mutations, deletes } = ctx.counts
    casefile.spend = {
      runs: casefile.spend.runs + 1,
      tokens: casefile.spend.tokens + turn.usage.totalTokens,
      cost: casefile.spend.cost + turn.usage.cost,
    }
    await this.cases.save(casefile)

    const directives =
      turn.stopped === "cost_ceiling"
        ? noDirectives()
        : parseDirectives(turn.text)

    if (directives.malformed) {
      console.warn(
        `[issue:${issueId}] malformed directive block; no comment posted:\n${turn.text}`,
      )
    }

    // A run stopped at the ceiling has no final answer: say so once, rather
    // than leaving the reporter with a stale status line.
    const comment =
      turn.stopped === "cost_ceiling"
        ? casefile.budgetNotified
          ? undefined
          : this.budgetComment()
        : directives.malformed
          ? undefined
          : directives.comment
    await publishComment(
      seerr,
      issueId,
      status,
      comment
        ? turn.stopped === "cost_ceiling"
          ? comment
          : `${comment}\n\n${usageAnchor(this.modelSpec, turn.usage)}`
        : undefined,
    )
    if (turn.stopped === "cost_ceiling") casefile.budgetNotified = true

    if (!directives.malformed && directives.resolve) {
      await seerr.setStatus(issueId, "resolved")
    }

    // Host-written, so continuity survives a run that never called the tool.
    if (comment) casefile.lastAnswer = clampEntry(comment)
    casefile.runs.push({
      at: new Date().toISOString(),
      trigger: event.kind === "revisit" ? "revisit" : "webhook",
      mutations,
      deletes,
      tokens: turn.usage.totalTokens,
      cost: turn.usage.cost,
      commented: comment !== undefined && comment.length > 0,
      resolved: directives.resolve,
    })
    const plan = planRevisit({
      requestedMs: directives.revisitInMs,
      reason: directives.revisitReason,
      mediaScope: eventMediaScope(event),
      previous: casefile.revisit,
      isRevisitRun: event.kind === "revisit",
      producedNews: mutations > 0 || (comment !== undefined && comment !== ""),
      maxChain: this.config.maxRevisitChain,
      now: Date.now(),
    })
    if (plan.refused) console.warn(`[issue:${issueId}] ${plan.refused}`)
    // A resolved issue is closed: never wake it again on an old schedule.
    casefile.revisit = directives.resolve ? undefined : plan.revisit
    await this.cases.save(casefile)

    console.log(
      `[issue:${issueId}] done resolve=${directives.resolve} revisit=${plan.revisit?.delayMs ?? "-"} ` +
        `mutations=${mutations} deletes=${deletes} tokens=${turn.usage.totalTokens} ` +
        `cost=$${turn.usage.cost.toFixed(4)} issueTotal=$${casefile.spend.cost.toFixed(2)}` +
        (turn.stopped ? ` stopped=${turn.stopped}` : ""),
    )
    return { issueId, directives, casefile }
  }

  private budgetComment(): string {
    return `${this.config.budgetMessage}\n\n${this.anchor}`
  }
}

/**
 * Publishes the run's one public comment: it overwrites the live status line
 * the agent posted via `report_progress` when there is one. Without a final
 * comment the status line is removed, so no stale "looking into it" survives.
 */
export async function publishComment(
  seerr: Pick<SeerrClient, "postComment" | "updateComment" | "deleteComment">,
  issueId: string,
  status: StatusComment,
  body: string | undefined,
): Promise<void> {
  if (body === undefined) {
    if (status.id !== undefined) await seerr.deleteComment(status.id)
    return
  }
  if (status.id === undefined) {
    await seerr.postComment(issueId, body)
    return
  }
  await seerr.updateComment(status.id, body)
}
