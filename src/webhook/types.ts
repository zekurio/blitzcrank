/**
 * Seerr (Jellyseerr/Overseerr) webhook payload.
 *
 * Shape follows the default webhook JSON payload template, verified against
 * the Jellyseerr source — see docs/research/seerr.md. Note: numeric IDs
 * (tmdbId, tvdbId, issue_id) are rendered as strings by the template.
 */
export type SeerrNotificationType =
  | "ISSUE_CREATED"
  | "ISSUE_COMMENT"
  | "ISSUE_RESOLVED"
  | "ISSUE_REOPENED"
  | "TEST_NOTIFICATION"
  | (string & {});

export interface SeerrMedia {
  media_type?: "movie" | "tv";
  imdbId?: string;
  tmdbId?: number | string;
  tvdbId?: number | string;
  jellyfinMediaId?: string;
  status?: string;
  status4k?: string;
}

export interface SeerrIssue {
  issue_id?: number | string;
  issue_type?: "VIDEO" | "AUDIO" | "SUBTITLES" | "OTHER" | (string & {});
  issue_status?: "OPEN" | "RESOLVED" | (string & {});
  reportedBy_email?: string;
  reportedBy_username?: string;
  reportedBy_avatar?: string;
}

export interface SeerrComment {
  comment_message?: string;
  commentedBy_email?: string;
  commentedBy_username?: string;
}

export interface SeerrWebhookPayload {
  notification_type: SeerrNotificationType;
  event?: string;
  subject?: string;
  message?: string;
  image?: string;
  media?: SeerrMedia | null;
  request?: unknown;
  issue?: SeerrIssue | null;
  /** For TV issues: [{name: "Affected Season", value: "2"}, {name: "Affected Episode", value: "5"}] */
  comment?: SeerrComment | null;
  extra?: Array<{ name: string; value: string }>;
}

export function isIssueEvent(payload: SeerrWebhookPayload): boolean {
  return payload.notification_type?.startsWith("ISSUE_") ?? false;
}
