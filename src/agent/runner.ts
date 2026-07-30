import { stat } from "node:fs/promises"
import path from "node:path"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

import { CaseStore, clampEntry, type CaseFile } from "../casefile.js"
import type { Config } from "../config.js"
import { MAX_REVISIT_CHAIN, planRevisit } from "../revisits.js"
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
    // Evidence carries across the runs of one issue, matching the session that
    // is resumed alongside it: the gate exists to stop fabricated IDs, and a
    // real ID does not become fabricated by being a day old. Neither counter is
    // capped for issue runs — what an issue needs is set by the issue, and a
    // season imported as the wrong show needs every one of its files gone.
    const ctx = new RunContext({
      prior: await this.cases.loadEvidence(issueId),
    })
    const sessionFileRef: SessionFileRef = { current: undefined }
    // The agent's progress tool posts this once and edits it in place; the
    // final comment then overwrites it, so a run leaves one comment at most.
    const status: StatusComment = { id: undefined }
    const revisitsLeft = Math.max(
      0,
      MAX_REVISIT_CHAIN -
        (event.kind === "revisit" ? (casefile.revisit?.chain ?? 0) : 0),
    )
    // Checked here, not just inside the session factory, because the prompt
    // depends on the answer: a resumed run gets a short delta prompt, and
    // sending that to a session that silently started blank would leave the
    // agent working an issue it was never told about.
    const resuming =
      casefile.sessionFile !== undefined &&
      (await stat(casefile.sessionFile).then(
        (s) => s.isFile(),
        () => false,
      ))

    const tools = buildIssueTools({
      config: this.config,
      ctx,
      seerr,
      issueId,
      anchor: this.anchor,
      sessionFileRef,
      mediaScope: eventMediaScope(event),
      status,
      casefile,
    })

    const turn = await runAgentTurn({
      modelRuntime: this.modelRuntime,
      modelSpec: this.modelSpec,
      // Built from the tools themselves, so the prompt cannot claim a
      // capability this run does not have, or deny one it does.
      systemPrompt: buildSystemPrompt(
        this.config,
        tools.map((tool) => tool.name),
      ),
      tools,
      prompt:
        event.kind === "webhook"
          ? buildIssuePrompt(event.payload, casefile, revisitsLeft, resuming)
          : buildRevisitPrompt(
              event.issueId,
              event.reason,
              casefile,
              revisitsLeft,
              resuming,
            ),
      sessionDir: path.join(this.config.dataDir, "sessions", "issues"),
      resumeFile: resuming ? casefile.sessionFile : undefined,
      sessionFileRef,
      logPrefix: `issue:${issueId}`,
    })

    // Usage is recorded before any Seerr call: a failure while commenting must
    // not make a run invisible in the issue's running total.
    const { mutations, deletes } = ctx.counts
    casefile.spend = {
      runs: casefile.spend.runs + 1,
      tokens: casefile.spend.tokens + turn.usage.newTokens,
      deletes: casefile.spend.deletes + deletes,
    }
    // Recorded before the directive block is even parsed: a run that mutated
    // and then crashed still has to show what it did.
    casefile.sessionFile = turn.sessionFile
    await this.cases.save(casefile)
    await this.cases.saveEvidence(issueId, ctx.snapshot)

    const directives = parseDirectives(turn.text)

    if (directives.malformed) {
      console.warn(
        `[issue:${issueId}] malformed directive block; no comment posted:\n${turn.text}`,
      )
    }

    const comment = directives.malformed ? undefined : directives.comment
    await publishComment(
      seerr,
      issueId,
      status,
      comment
        ? `${comment}\n\n${usageAnchor(this.modelSpec, casefile.spend.tokens)}`
        : undefined,
    )

    if (!directives.malformed && directives.resolve) {
      await seerr.setStatus(issueId, "resolved")
      // A closed issue keeps its case file (audit trail, and `spend.deletes`
      // must not reset if it is reopened) but drops the bulky raw evidence.
      await this.cases.forgetEvidence(issueId)
    }

    // Host-written, so continuity survives a run that never called the tool.
    if (comment) casefile.lastAnswer = clampEntry(comment)
    casefile.runs.push({
      at: new Date().toISOString(),
      trigger: event.kind === "revisit" ? "revisit" : "webhook",
      mutations,
      deletes,
      tokens: turn.usage.newTokens,
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
      maxChain: MAX_REVISIT_CHAIN,
      now: Date.now(),
    })
    if (plan.refused) console.warn(`[issue:${issueId}] ${plan.refused}`)
    // A resolved issue is closed: never wake it again on an old schedule.
    casefile.revisit = directives.resolve ? undefined : plan.revisit
    await this.cases.save(casefile)

    console.log(
      `[issue:${issueId}] done resolve=${directives.resolve} revisit=${plan.revisit?.delayMs ?? "-"} ` +
        `mutations=${mutations} deletes=${deletes} tokens=${turn.usage.newTokens} ` +
        `billed=${turn.usage.billedTokens} ` +
        `issueTotal=${casefile.spend.tokens} runs=${casefile.spend.runs}`,
    )
    return { issueId, directives, casefile }
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
