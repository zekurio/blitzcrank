import type { ServiceConfig } from "../config.js"
import { jsonRequest } from "./http.js"

/** Host-owned Seerr issue lifecycle: fetching, commenting, status changes. */
export class SeerrClient {
  constructor(
    private readonly cfg: ServiceConfig,
    private readonly botUserId: string | undefined,
  ) {}

  private headers(): Record<string, string> {
    return {
      "X-Api-Key": this.cfg.apiKey,
      ...(this.botUserId ? { "X-Api-User": this.botUserId } : {}),
    }
  }

  getIssue(issueId: string | number): Promise<unknown> {
    return jsonRequest(this.cfg.url, `/api/v1/issue/${issueId}`, {
      headers: this.headers(),
    })
  }

  postComment(issueId: string | number, message: string): Promise<unknown> {
    return jsonRequest(this.cfg.url, `/api/v1/issue/${issueId}/comment`, {
      method: "POST",
      headers: this.headers(),
      body: { message },
    })
  }

  setStatus(
    issueId: string | number,
    status: "open" | "resolved",
  ): Promise<unknown> {
    return jsonRequest(this.cfg.url, `/api/v1/issue/${issueId}/${status}`, {
      method: "POST",
      headers: this.headers(),
    })
  }
}
