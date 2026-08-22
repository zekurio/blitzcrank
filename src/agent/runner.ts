import { stat } from "node:fs/promises"
import path from "node:path"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

import { CaseStore, clampEntry, type CaseFile } from "../casefile.ts"
import type { Config } from "../config.ts"
import type { SeerrWebhookPayload } from "../gateways/seerr/types.ts"
import { MAX_REVISIT_CHAIN, planRevisit } from "../revisits.ts"
import { SeerrClient } from "../services/seerr.ts"
import { RunContext } from "../tools/context.ts"
import {
  buildIssueTools,
  type MediaScope,
  type SessionFileRef,
  type StatusComment,
} from "../tools/index.ts"
import { parseDirectives, type Directives } from "./directives.ts"
import {
  buildIssuePrompt,
  buildRevisitPrompt,
  buildSystemPrompt,
} from "./prompt.ts"
import { modelAnchor, runAgentTurn, usageAnchor } from "./session.ts"

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
  /** Serializes queue notices; see notifyQueued. */
  private noticeChain: Promise<unknown> = Promise.resolve()

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

  /**
   * Posts the status line before a delayed webhook run reaches the front of
   * the serial queue. The run adopts the returned handle, so its first
   * progress update and final answer replace this comment instead of adding
   * another.
   *
   * Notices are posted one at a time: postComment infers the new comment's
   * id as the max of the issue's comment list, so two notices for one issue
   * in flight together could observe both POSTs and return the same handle —
   * one run would then rewrite or delete the other's notice out from under
   * it.
   */
  async notifyQueued(
    issueId: string,
    runsAhead: number,
  ): Promise<StatusComment> {
    const notice = this.noticeChain.then(async () => {
      const seerr = new SeerrClient(
        this.config.seerr,
        this.config.seerrBotUserId,
      )
      const message = queuedMessage(this.config.language, runsAhead)
      const id = await seerr.postComment(
        issueId,
        `${message}\n\n${this.anchor}`,
      )
      return { id }
    })
    // A failed notice must not wedge the chain; its caller already logs the
    // failure and runs without a handle.
    this.noticeChain = notice.catch(() => undefined)
    return notice
  }

  async run(
    event: IssueEvent,
    status: StatusComment = { id: undefined },
  ): Promise<RunOutcome> {
    const { issueId } = event
    const seerr = new SeerrClient(this.config.seerr, this.config.seerrBotUserId)
    try {
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
      // The agent's progress tool posts this once and edits it in place; when
      // the host already posted a queue notice it adopts that comment instead.
      // The final answer overwrites either status — and a run that dies before
      // then retracts it — so a run leaves one comment at most.
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
        systemPrompt: buildSystemPrompt(this.config),
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
        codexSearch: true,
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
        inputTokens:
          casefile.spend.inputTokens === undefined
            ? undefined
            : casefile.spend.inputTokens + turn.usage.inputTokens,
        outputTokens:
          casefile.spend.outputTokens === undefined
            ? undefined
            : casefile.spend.outputTokens + turn.usage.outputTokens,
        costUsd:
          casefile.spend.costUsd === undefined
            ? undefined
            : casefile.spend.costUsd + (turn.usage.costUsd ?? 0),
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
          ? `${comment}\n\n${usageAnchor(
              this.modelSpec,
              casefile.spend.tokens,
              casefile.spend.inputTokens,
              casefile.spend.outputTokens,
              turn.usage.costUsd === undefined
                ? undefined
                : casefile.spend.costUsd,
              turn.usage.costUsd,
            )}`
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
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        commented: comment !== undefined && comment.length > 0,
        resolved: directives.resolve,
      })
      const plan = planRevisit({
        requestedMs: directives.revisitInMs,
        reason: directives.revisitReason,
        mediaScope: eventMediaScope(event),
        previous: casefile.revisit,
        isRevisitRun: event.kind === "revisit",
        producedNews:
          mutations > 0 || (comment !== undefined && comment !== ""),
        maxChain: MAX_REVISIT_CHAIN,
        now: Date.now(),
      })
      if (plan.refused) console.warn(`[issue:${issueId}] ${plan.refused}`)
      // A resolved issue is closed: never wake it again on an old schedule.
      casefile.revisit = directives.resolve ? undefined : plan.revisit
      await this.cases.save(casefile)

      console.log(
        `[issue:${issueId}] done resolve=${directives.resolve} revisit=${plan.revisit?.delayMs ?? "-"} ` +
          `mutations=${mutations} deletes=${deletes} ` +
          `tokens=${turn.usage.newTokens} input=${turn.usage.inputTokens} ` +
          `output=${turn.usage.outputTokens} billed=${turn.usage.billedTokens} ` +
          `cost=${turn.usage.costUsd ?? "subscription"} ` +
          `issueTotal=${casefile.spend.tokens} runs=${casefile.spend.runs}`,
      )
      return { issueId, directives, casefile }
    } catch (err) {
      // The run died before its final comment, so the live status it adopted
      // or posted — the queue notice or a progress line — would otherwise stay
      // on the issue forever. publishComment cleared the handle once the final
      // comment was out, so whatever it still points at is a status that must
      // be retracted. The queue logs the run's own failure; a failed
      // retraction only joins it there.
      await publishComment(seerr, issueId, status, undefined).catch(
        (cleanupErr: unknown) => {
          console.error(
            `[issue:${issueId}] failed to retract status comment:`,
            cleanupErr,
          )
        },
      )
      throw err
    }
  }
}

function queuedMessage(language: string, runsAhead: number): string {
  const german = /^(de|deutsch|german)(-|_|\b)/i.test(language.trim())
  if (german) {
    const ahead =
      runsAhead === 1
        ? "Eine Aufgabe ist noch vor ihr."
        : `${runsAhead} Aufgaben sind noch vor ihr.`
    return `⏳ Blitzcrank ist gerade beschäftigt. Deine Meldung ist eingereiht. ${ahead}`
  }
  const ahead =
    runsAhead === 1
      ? "One task is ahead of it."
      : `${runsAhead} tasks are ahead of it.`
  return `⏳ Blitzcrank is currently busy. Your issue is queued. ${ahead}`
}

/**
 * Publishes the run's one public comment: it overwrites the live status line
 * the agent posted via `report_progress` when there is one. Without a final
 * comment the status line is removed, so no stale "looking into it" survives.
 * The handle is cleared on success: the status is resolved — deleted, or now
 * carrying the final answer — so a run failing after this point must not
 * retract it.
 */
export async function publishComment(
  seerr: Pick<SeerrClient, "postComment" | "updateComment" | "deleteComment">,
  issueId: string,
  status: StatusComment,
  body: string | undefined,
): Promise<void> {
  if (body === undefined) {
    if (status.id !== undefined) await seerr.deleteComment(status.id)
  } else if (status.id === undefined) {
    await seerr.postComment(issueId, body)
  } else {
    await seerr.updateComment(status.id, body)
  }
  status.id = undefined
}
