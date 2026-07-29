import path from "node:path"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

import type { Config } from "../config.js"
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
}

export class IssueRunner {
  constructor(
    private readonly config: Config,
    private readonly modelRuntime: ModelRuntime,
    private readonly modelSpec: string,
  ) {}

  get anchor(): string {
    return modelAnchor(this.modelSpec)
  }

  async run(event: IssueEvent): Promise<RunOutcome> {
    const { issueId } = event
    const ctx = new RunContext()
    const seerr = new SeerrClient(this.config.seerr, this.config.seerrBotUserId)
    const sessionFileRef: SessionFileRef = { current: undefined }
    // The agent's progress tool posts this once and edits it in place; the
    // final comment then overwrites it, so a run leaves one comment at most.
    const status: StatusComment = { id: undefined }

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
      }),
      prompt:
        event.kind === "webhook"
          ? buildIssuePrompt(event.payload)
          : buildRevisitPrompt(event.issueId, event.reason),
      sessionDir: path.join(this.config.dataDir, "sessions", "issues"),
      sessionFileRef,
      logPrefix: `issue:${issueId}`,
    })

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
        ? `${comment}\n\n${usageAnchor(this.modelSpec, turn.usage)}`
        : undefined,
    )

    if (!directives.malformed && directives.resolve) {
      await seerr.setStatus(issueId, "resolved")
    }

    const { mutations, deletes } = ctx.counts
    console.log(
      `[issue:${issueId}] done resolve=${directives.resolve} revisit=${directives.revisitInMs ?? "-"} ` +
        `mutations=${mutations} deletes=${deletes} tokens=${turn.usage.totalTokens} cost=$${turn.usage.cost.toFixed(4)}`,
    )
    return { issueId, directives }
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
