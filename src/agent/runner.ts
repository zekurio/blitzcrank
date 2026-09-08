import { stat } from "node:fs/promises"
import path from "node:path"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Effect, Semaphore } from "effect"

import { CaseStore, clampEntry, type CaseFile } from "../casefile.ts"
import type { Config } from "../config.ts"
import type { SeerrWebhookPayload } from "../gateways/seerr/types.ts"
import { MAX_REVISIT_CHAIN, planRevisit } from "../revisits.ts"
import { SeerrClient, seerrIssueMediaType } from "../services/seerr.ts"
import { RunContext } from "../tools/context.ts"
import {
  buildIssueTools,
  type MediaScope,
  type SessionFileRef,
  type StatusComment,
} from "../tools/index.ts"
import { buildWebProvider } from "../web/index.ts"
import { parseDirectives, type Directives } from "./directives.ts"
import { sdkPromise, SdkError } from "./effect.ts"
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
} from "./session.ts"

export type IssueEvent =
  | { kind: "webhook"; issueId: string; payload: SeerrWebhookPayload }
  | { kind: "revisit"; issueId: string; reason: string; mediaScope: MediaScope }

export function eventMediaScope(event: IssueEvent): MediaScope {
  if (event.kind === "revisit") return event.mediaScope
  const type = event.payload.media?.media_type
  return type === "movie" || type === "tv" ? type : undefined
}

function resolveMediaScopeEffect(
  event: IssueEvent,
  seerr: Pick<SeerrClient, "getIssue">,
) {
  return Effect.gen(function* () {
    const scope = eventMediaScope(event)
    if (scope !== undefined) return scope
    return seerrIssueMediaType(
      yield* sdkPromise(() => seerr.getIssue(event.issueId)),
    )
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
  notifyQueued(issueId: string, runsAhead: number): Promise<StatusComment> {
    return Effect.runPromise(this.notifyQueuedEffect(issueId, runsAhead))
  }

  notifyQueuedEffect(issueId: string, runsAhead: number) {
    return Effect.gen({ self: this }, function* () {
      const seerr = new SeerrClient(
        this.config.seerr,
        this.config.seerrBotUserId,
      )
      const message = queuedMessage(this.config.language, runsAhead)
      const id = yield* sdkPromise(() =>
        seerr.postComment(issueId, `${message}\n\n${this.anchor}`),
      )
      return { id }
    }).pipe(this.noticeLock.withPermits(1), Effect.uninterruptible)
  }

  run(
    event: IssueEvent,
    status: StatusComment = { id: undefined },
    signal?: AbortSignal,
  ): Promise<RunOutcome> {
    return Effect.runPromise(this.runEffect(event, status, signal))
  }

  runEffect(
    event: IssueEvent,
    status: StatusComment = { id: undefined },
    signal?: AbortSignal,
  ): Effect.Effect<RunOutcome, SdkError> {
    return Effect.gen({ self: this }, function* () {
      const { issueId } = event
      const seerr = new SeerrClient(
        this.config.seerr,
        this.config.seerrBotUserId,
      )
      return yield* Effect.gen({ self: this }, function* () {
        const mediaScope = yield* resolveMediaScopeEffect(event, seerr)
        if (mediaScope === undefined) {
          console.warn(
            `[issue:${issueId}] media type is unknown; no Arr tools granted`,
          )
        }
        const casefile = yield* sdkPromise(() => this.cases.load(issueId))
        // Evidence carries across the runs of one issue, matching the session that
        // is resumed alongside it: the gate exists to stop fabricated IDs, and a
        // real ID does not become fabricated by being a day old. Mutation and
        // deletion counts are audit data only.
        const ctx = new RunContext({
          prior: yield* sdkPromise(() => this.cases.loadEvidence(issueId)),
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
          (yield* sdkPromise(() => stat(casefile.sessionFile!)).pipe(
            Effect.map((s) => s.isFile()),
            Effect.catch(() => Effect.succeed(false)),
          ))

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
          prompt:
            event.kind === "webhook"
              ? buildIssuePrompt(
                  event.payload,
                  casefile,
                  revisitsLeft,
                  resuming,
                )
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
          signal,
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
        yield* sdkPromise(() => this.cases.save(casefile))
        yield* sdkPromise(() => this.cases.saveEvidence(issueId, ctx.snapshot))

        if (signal?.aborted) {
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
          yield* sdkPromise(() => this.cases.save(casefile))
          return yield* Effect.fail(
            new SdkError({ message: "issue run stopped", cause: undefined }),
          )
        }

        const directives = parseDirectives(turn.text)

        if (directives.malformed) {
          console.warn(
            `[issue:${issueId}] malformed directive block; no comment posted:\n${turn.text}`,
          )
        }

        const comment = directives.malformed ? undefined : directives.comment
        if (signal?.aborted)
          return yield* Effect.fail(
            new SdkError({ message: "issue run stopped", cause: undefined }),
          )
        yield* publishCommentEffect(
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
          if (signal?.aborted)
            return yield* Effect.fail(
              new SdkError({ message: "issue run stopped", cause: undefined }),
            )
          yield* sdkPromise(() => seerr.setStatus(issueId, "resolved"))
          // A closed issue keeps its case file (audit trail, and `spend.deletes`
          // must not reset if it is reopened) but drops the bulky raw evidence.
          yield* sdkPromise(() => this.cases.forgetEvidence(issueId))
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
          mediaScope,
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
        yield* sdkPromise(() => this.cases.save(casefile))

        return { issueId, directives, casefile }
      }).pipe(
        Effect.onExit(() =>
          // A successful publication clears the handle; only a live status remains.
          publishCommentEffect(seerr, issueId, status, undefined).pipe(
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

  retractStatus(issueId: string, status: StatusComment): Promise<void> {
    return Effect.runPromise(this.retractStatusEffect(issueId, status))
  }

  retractStatusEffect(issueId: string, status: StatusComment) {
    const seerr = new SeerrClient(this.config.seerr, this.config.seerrBotUserId)
    return publishCommentEffect(seerr, issueId, status, undefined)
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
  seerr: Pick<SeerrClient, "postComment" | "updateComment" | "deleteComment">,
  issueId: string,
  status: StatusComment,
  body: string | undefined,
) {
  return Effect.gen(function* () {
    if (body === undefined) {
      if (status.id !== undefined)
        yield* sdkPromise(() => seerr.deleteComment(status.id!))
    } else if (status.id === undefined) {
      yield* sdkPromise(() => seerr.postComment(issueId, body))
    } else {
      yield* sdkPromise(() => seerr.updateComment(status.id!, body))
    }
    status.id = undefined
  }).pipe(Effect.uninterruptible)
}

export function publishComment(
  seerr: Pick<SeerrClient, "postComment" | "updateComment" | "deleteComment">,
  issueId: string,
  status: StatusComment,
  body: string | undefined,
): Promise<void> {
  return Effect.runPromise(publishCommentEffect(seerr, issueId, status, body))
}
