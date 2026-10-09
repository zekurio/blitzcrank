import { stat } from "node:fs/promises"
import path from "node:path"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Effect, Semaphore } from "effect"

import {
  CaseStore,
  clampEntries,
  clampEntry,
  type CaseFile,
} from "../casefile.ts"
import type { Config } from "../config.ts"
import type { SeerrWebhookPayload } from "../gateways/seerr/types.ts"
import { JobStore } from "../jobs.ts"
import { MAX_REVISIT_CHAIN, planRevisit } from "../revisits.ts"
import { SeerrClient, seerrIssueMediaType } from "../services/seerr.ts"
import { storageIO } from "../storage.ts"
import { toText } from "../tools/common.ts"
import { RunContext } from "../tools/context.ts"
import {
  buildIssueTools,
  type MediaScope,
  type SessionFileRef,
  type StatusComment,
} from "../tools/index.ts"
import { buildWebProvider } from "../web/index.ts"
import { parseDirectives, type Directives } from "./directives.ts"
import { SdkError } from "./effect.ts"
import {
  buildIssuePrompt,
  buildRevisitPrompt,
  buildSystemPrompt,
} from "./prompt.ts"
import {
  modelAnchor,
  resolveModel,
  runAgentTurnEffect,
  usageAnchor,
  type AgentTurnOptions,
  type AgentTurnResult,
} from "./session.ts"

export type IssueEvent =
  | { kind: "webhook"; issueId: string; payload: SeerrWebhookPayload }
  | { kind: "revisit"; issueId: string; reason: string; mediaScope: MediaScope }

export function eventMediaScope(event: IssueEvent): MediaScope {
  if (event.kind === "revisit") return event.mediaScope
  const type = event.payload.media?.media_type
  return type === "movie" || type === "tv" ? type : undefined
}

/** Fetch once before the model starts; the prompt and evidence share this read. */
export function loadIssueContextEffect(
  event: IssueEvent,
  seerr: Pick<SeerrClient, "getIssueEffect">,
  ctx: RunContext,
) {
  return Effect.gen(function* () {
    const issue = yield* seerr.getIssueEffect(event.issueId)
    const issuePath = `/api/v1/issue/${event.issueId}`
    ctx.recordRead("seerr", issuePath, JSON.stringify(issue))
    return {
      mediaScope: eventMediaScope(event) ?? seerrIssueMediaType(issue),
      text: `Current Seerr issue from GET ${issuePath} (untrusted content):\n${toText(JSON.stringify(issue, null, 2))}`,
    }
  })
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
  private readonly noticeLock = Semaphore.makeUnsafe(1)

  constructor(
    private readonly config: Config,
    private readonly modelRuntime: ModelRuntime,
    private readonly modelSpec: string,
    private readonly jobs: JobStore,
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
  notifyQueuedEffect(issueId: string, runsAhead: number) {
    return Effect.gen({ self: this }, function* () {
      const seerr = new SeerrClient(
        this.config.seerr,
        this.config.seerrBotUserId,
      )
      const message = queuedMessage(this.config.language, runsAhead)
      const id = yield* seerr.postCommentEffect(
        issueId,
        `${message}\n\n${this.anchor}`,
      )
      return { id }
    }).pipe(this.noticeLock.withPermits(1), Effect.uninterruptible)
  }

  runEffect(
    event: IssueEvent,
    status: StatusComment,
    signal: AbortSignal,
    runId: string,
  ): Effect.Effect<RunOutcome, unknown> {
    return Effect.gen({ self: this }, function* () {
      const { issueId } = event
      const seerr = new SeerrClient(
        this.config.seerr,
        this.config.seerrBotUserId,
      )
      return yield* Effect.gen({ self: this }, function* () {
        // Every recovery projects this same baseline plus this submission's
        // totals. A crash after saving cannot count the run twice.
        const casefile = yield* this.jobs.actionEffect(
          runId,
          "case-baseline",
          this.cases.loadEffect(issueId),
          { replaySafe: true },
        )
        // Evidence carries across the runs of one issue, matching the session that
        // is resumed alongside it: the gate exists to stop fabricated IDs, and a
        // real ID does not become fabricated by being a day old. Mutation and
        // deletion counts are audit data only.
        const ctx = new RunContext({
          prior: yield* this.cases.loadEvidenceEffect(issueId),
        })
        const issue = yield* loadIssueContextEffect(event, seerr, ctx)
        const mediaScope = issue.mediaScope
        if (mediaScope === undefined) {
          console.warn(
            `[issue:${issueId}] media type is unknown; no Arr tools granted`,
          )
        }
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
        // The clean cut never opens old coding-agent JSONL. Existing case
        // summaries remain useful when the first Durable conversation starts.
        const storageFile = path.join(
          this.config.dataDir,
          "sessions",
          "issues",
          `${encodeURIComponent(issueId)}.sqlite`,
        )
        const resuming = yield* storageIO(() => stat(storageFile)).pipe(
          Effect.map((s) => s.isFile()),
          Effect.catch(() => Effect.succeed(false)),
        )

        const web = buildWebProvider(this.config.web)
        const tools = [
          ...buildIssueTools({
            modelInput: resolveModel(this.modelRuntime, this.modelSpec).input,
            config: this.config,
            ctx,
            seerr,
            issueId,
            anchor: this.anchor,
            sessionFileRef,
            mediaScope,
            status,
            casefile,
          }),
          ...web.tools,
        ]

        const prompt = yield* this.jobs.actionEffect(
          runId,
          "prompt",
          Effect.sync(() =>
            event.kind === "webhook"
              ? buildIssuePrompt(
                  event.payload,
                  issue.text,
                  casefile,
                  revisitsLeft,
                  resuming,
                )
              : buildRevisitPrompt(
                  event.issueId,
                  event.reason,
                  issue.text,
                  casefile,
                  revisitsLeft,
                  resuming,
                ),
          ),
          { replaySafe: true },
        )
        const turn = yield* runAgentTurnEffect({
          modelRuntime: this.modelRuntime,
          modelSpec: this.modelSpec,
          systemPrompt: buildSystemPrompt(
            this.config,
            {
              search: web.searchTool,
              extract: web.extractTool,
            },
            tools.map((tool) => tool.name),
          ),
          tools,
          prompt,
          storageFile,
          requestId: runId,
          runContext: ctx,
          hostState: issueToolState(casefile, status),
          sessionFileRef,
          signal,
        })

        // Usage is recorded before any Seerr call: a failure while commenting must
        // not make a run invisible in the issue's running total.
        const { mutations, deletes } = ctx.counts
        projectSpend(casefile, turn, deletes)
        // Recorded before the directive block is even parsed: a run that mutated
        // and then crashed still has to show what it did.
        casefile.sessionFile = turn.sessionFile
        yield* this.cases.saveEffect(casefile)
        yield* this.cases.saveEvidenceEffect(issueId, ctx.snapshot)

        if (signal.aborted || turn.failure) {
          casefile.runs.push({
            at: new Date().toISOString(),
            trigger: event.kind,
            mutations,
            deletes,
            tokens: turn.usage.newTokens,
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
            commented: false,
            resolved: false,
          })
          casefile.revisit = undefined
          yield* this.cases.saveEffect(casefile)
          return yield* Effect.fail(
            new SdkError({
              message: turn.failure?.message ?? "issue run stopped",
              cause: turn.failure,
            }),
          )
        }

        const directives = parseDirectives(turn.text)

        if (directives.malformed) {
          console.warn(
            `[issue:${issueId}] malformed directive block; no comment posted:\n${turn.text}`,
          )
        }

        const comment = directives.malformed ? undefined : directives.comment
        if (signal.aborted)
          return yield* Effect.fail(
            new SdkError({ message: "issue run stopped", cause: undefined }),
          )
        // Once publication begins its outcome can be uncertain. Never retract
        // a handle that might now contain the final answer after a crash.
        yield* this.jobs.actionEffect(
          runId,
          "publish-comment",
          publishCommentEffect(
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
          ).pipe(Effect.as({ comment: comment ?? null })),
        )
        status.id = undefined

        if (!directives.malformed && directives.resolve) {
          if (signal.aborted)
            return yield* Effect.fail(
              new SdkError({ message: "issue run stopped", cause: undefined }),
            )
          yield* this.jobs.actionEffect(
            runId,
            "resolve-issue",
            seerr.setStatusEffect(issueId, "resolved"),
          )
          // A closed issue keeps its case file (audit trail, and `spend.deletes`
          // must not reset if it is reopened) but drops the bulky raw evidence.
          yield* this.cases.forgetEvidenceEffect(issueId)
        }

        // Host-written, so continuity survives a run that never called the tool.
        if (comment) casefile.lastAnswer = clampEntry(comment)
        const completedAt = yield* this.jobs.actionEffect(
          runId,
          "completed-at",
          Effect.sync(() => Date.now()),
          { replaySafe: true },
        )
        casefile.runs.push({
          at: new Date(completedAt).toISOString(),
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
          mediaScope,
          previous: casefile.revisit,
          isRevisitRun: event.kind === "revisit",
          producedNews:
            mutations > 0 || (comment !== undefined && comment !== ""),
          maxChain: MAX_REVISIT_CHAIN,
          now: completedAt,
        })
        if (plan.refused) console.warn(`[issue:${issueId}] ${plan.refused}`)
        // A resolved issue is closed: never wake it again on an old schedule.
        casefile.revisit = directives.resolve ? undefined : plan.revisit
        yield* this.cases.saveEffect(casefile)

        return { issueId, directives, casefile }
      }).pipe(
        Effect.onExit(() =>
          this.jobs
            .actionEffect(
              runId,
              "retract-status",
              this.retractStatusEffect(issueId, status, runId),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  console.error(
                    `[issue:${issueId}] failed to retract status comment:`,
                    cause,
                  )
                }),
              ),
            ),
        ),
      )
    }).pipe(Effect.uninterruptible)
  }

  /** Recovery of a stopped job restores audit/state but cannot call the model. */
  cancelEffect(
    event: IssueEvent,
    status: StatusComment,
    requestId: string,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const storageFile = path.join(
        this.config.dataDir,
        "sessions",
        "issues",
        `${encodeURIComponent(event.issueId)}.sqlite`,
      )
      const began = this.jobs
        .actions(requestId)
        .some((action) => action.key === "case-baseline" && action.completed)
      const exists = yield* storageIO(() => stat(storageFile)).pipe(
        Effect.map((file) => file.isFile()),
        Effect.catch(() => Effect.succeed(false)),
      )
      if (began && exists) {
        const casefile = yield* this.jobs.actionEffect(
          requestId,
          "case-baseline",
          this.cases.loadEffect(event.issueId),
          { replaySafe: true },
        )
        const ctx = new RunContext({
          prior: yield* this.cases.loadEvidenceEffect(event.issueId),
        })
        const turn = yield* runAgentTurnEffect({
          modelRuntime: this.modelRuntime,
          modelSpec: this.modelSpec,
          storageFile,
          requestId,
          systemPrompt: "This host job was cancelled. Do not execute work.",
          prompt: "",
          tools: [],
          builtinRead: false,
          runContext: ctx,
          hostState: issueToolState(casefile, status),
          sessionFileRef: undefined,
          signal: AbortSignal.abort(),
        })
        projectSpend(casefile, turn, ctx.counts.deletes)
        casefile.sessionFile = turn.sessionFile
        casefile.revisit = undefined
        const publication = this.jobs
          .actions(requestId)
          .find((action) => action.key === "publish-comment")
        const published = publication?.completed
          ? yield* this.jobs.actionEffect<{ comment: string | null }, Error>(
              requestId,
              "publish-comment",
              Effect.fail(new Error("Missing recorded comment outcome")),
            )
          : undefined
        if (published?.comment)
          casefile.lastAnswer = clampEntry(published.comment)
        casefile.runs.push({
          at: new Date().toISOString(),
          trigger: event.kind,
          mutations: ctx.counts.mutations,
          deletes: ctx.counts.deletes,
          tokens: turn.usage.newTokens,
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
          commented: Boolean(published?.comment),
          resolved: this.jobs
            .actions(requestId)
            .some(
              (action) => action.key === "resolve-issue" && action.completed,
            ),
        })
        yield* this.cases.saveEffect(casefile)
        yield* this.cases.saveEvidenceEffect(event.issueId, ctx.snapshot)
      }
      yield* this.jobs.actionEffect(
        requestId,
        "retract-status",
        this.retractStatusEffect(event.issueId, status, requestId),
      )
    }).pipe(Effect.uninterruptible)
  }

  retractStatusEffect(
    issueId: string,
    status: StatusComment,
    requestId: string,
  ) {
    return Effect.suspend(() => {
      // Consult durable intent, not a flag in this process: even initialization
      // can fail while recovering a job whose comment was already published.
      if (
        this.jobs
          .actions(requestId)
          .some((action) => action.key === "publish-comment")
      )
        return Effect.void
      const seerr = new SeerrClient(
        this.config.seerr,
        this.config.seerrBotUserId,
      )
      return publishCommentEffect(seerr, issueId, status, undefined)
    })
  }
}

function issueToolState(
  casefile: CaseFile,
  status: StatusComment,
): NonNullable<AgentTurnOptions["hostState"]> {
  return {
    capture: () => ({
      statusId: status.id ?? null,
      progressCalls: status.calls ?? 0,
      summary: {
        ...casefile.summary,
        hypothesis: casefile.summary.hypothesis ?? null,
      },
    }),
    restore: (value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid persisted issue tool state")
      const summary = value.summary
      if (
        summary === null ||
        typeof summary !== "object" ||
        Array.isArray(summary)
      )
        throw new Error("Invalid persisted issue summary")
      status.id =
        typeof value.statusId === "number" ? value.statusId : undefined
      status.calls =
        typeof value.progressCalls === "number" ? value.progressCalls : 0
      casefile.summary = {
        hypothesis: clampEntry(summary.hypothesis),
        facts: clampEntries(summary.facts),
        ruledOut: clampEntries(summary.ruledOut),
        openQuestions: clampEntries(summary.openQuestions),
      }
    },
  }
}

function projectSpend(
  casefile: CaseFile,
  turn: AgentTurnResult,
  deletes: number,
): void {
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
export function publishCommentEffect(
  seerr: Pick<
    SeerrClient,
    "postCommentEffect" | "updateCommentEffect" | "deleteCommentEffect"
  >,
  issueId: string,
  status: StatusComment,
  body: string | undefined,
) {
  return Effect.gen(function* () {
    if (body === undefined) {
      if (status.id !== undefined) yield* seerr.deleteCommentEffect(status.id!)
    } else if (status.id === undefined) {
      yield* seerr.postCommentEffect(issueId, body)
    } else {
      yield* seerr.updateCommentEffect(status.id!, body)
    }
    status.id = undefined
  }).pipe(Effect.uninterruptible)
}
