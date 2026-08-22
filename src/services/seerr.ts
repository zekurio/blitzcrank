import type { ServiceConfig } from "../config.ts"
import { jsonRequest, type JsonValue } from "./http.ts"

export interface SeerrUser {
  id?: number
  email?: string
  username?: string
  displayName?: string
  permissions?: number
}

export interface SeerrIssue {
  createdBy?: SeerrUser
  media?: { mediaType?: string }
}

/** Reads the runtime Media.mediaType field from one Seerr issue response. */
export function seerrIssueMediaType(
  issue: SeerrIssue,
): "movie" | "tv" | undefined {
  const type = issue.media?.mediaType
  return type === "movie" || type === "tv" ? type : undefined
}

/** Host-owned Seerr issue lifecycle: fetching, commenting, status changes. */
export class SeerrClient {
  constructor(
    private readonly cfg: ServiceConfig,
    private readonly botUserId: string | undefined,
  ) {}

  private headers(): Headers {
    const headers = new Headers({ "X-Api-Key": this.cfg.apiKey })
    if (this.botUserId) headers.set("X-Api-User", this.botUserId)
    return headers
  }

  getIssue(issueId: string | number): Promise<SeerrIssue> {
    return jsonRequest<SeerrIssue>(this.cfg.url, `/api/v1/issue/${issueId}`, {
      headers: this.headers(),
    })
  }

  async listUsers(): Promise<SeerrUser[]> {
    const response = await jsonRequest<{ results?: SeerrUser[] }>(
      this.cfg.url,
      "/api/v1/user?take=200",
      { headers: this.headers() },
    )
    return response.results ?? []
  }

  /**
   * Posts a comment; returns its id (newest of the returned issue comments).
   * The inference is ambiguous when two posts to one issue race, so posting
   * must be serialized by the caller (see IssueRunner.notifyQueued).
   */
  async postComment(
    issueId: string | number,
    message: string,
  ): Promise<number | undefined> {
    const issue = await jsonRequest<{ comments?: Array<{ id?: number }> }>(
      this.cfg.url,
      `/api/v1/issue/${issueId}/comment`,
      { method: "POST", headers: this.headers(), body: { message } },
    )
    const ids = (issue?.comments ?? [])
      .map((comment) => comment.id)
      .filter((id): id is number => typeof id === "number")
    return ids.length > 0 ? Math.max(...ids) : undefined
  }

  /** Rewrites an existing comment in place (author or MANAGE_ISSUES only). */
  updateComment(commentId: number, message: string): Promise<JsonValue> {
    return jsonRequest(this.cfg.url, `/api/v1/issueComment/${commentId}`, {
      method: "PUT",
      headers: this.headers(),
      body: { message },
    })
  }

  deleteComment(commentId: number): Promise<JsonValue> {
    return jsonRequest(this.cfg.url, `/api/v1/issueComment/${commentId}`, {
      method: "DELETE",
      headers: this.headers(),
    })
  }

  setStatus(
    issueId: string | number,
    status: "open" | "resolved",
  ): Promise<JsonValue> {
    return jsonRequest(this.cfg.url, `/api/v1/issue/${issueId}/${status}`, {
      method: "POST",
      headers: this.headers(),
    })
  }
}
