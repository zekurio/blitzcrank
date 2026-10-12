import { SIGNATURE_PREFIX } from "../../gateway.ts"
import type { JsonValue } from "../../services/http.ts"
import type { SeerrIssue } from "./client.ts"

const MAX_COMMENTS = 5
const MAX_COMMENT_CHARS = 2_000

/** A prompt gets issue identity and discussion, never Seerr's user records. */
export function issueContext(issue: SeerrIssue) {
  const comments = (Array.isArray(issue.comments) ? issue.comments : [])
    .filter(isRecord)
    .filter(
      (comment) =>
        typeof comment.message === "string" &&
        !comment.message.includes(SIGNATURE_PREFIX),
    )
    .toSorted((a, b) => Number(a.id) - Number(b.id))
  // The first comment is the report. Keep it even on long follow-up threads.
  const selected =
    comments.length > MAX_COMMENTS
      ? [comments[0]!, ...comments.slice(-(MAX_COMMENTS - 1))]
      : comments
  return {
    ...fields(issue, [
      "id",
      "issueType",
      "problemSeason",
      "problemEpisode",
      "createdAt",
    ]),
    reporter: person(issue.createdBy),
    media: fields(issue.media, [
      "mediaType",
      "tmdbId",
      "tvdbId",
      "imdbId",
      "jellyfinMediaId",
      "externalServiceId",
      "externalServiceSlug",
      "status",
      "status4k",
    ]),
    comments: selected.map((comment) => {
      const message = redactEmails(String(comment.message))
      return {
        ...fields(comment, ["id", "createdAt"]),
        user: person(comment.user),
        message: message.slice(0, MAX_COMMENT_CHARS),
        ...(message.length > MAX_COMMENT_CHARS ? { truncated: true } : {}),
      }
    }),
    omittedComments: comments.length - selected.length,
  }
}

function person(value: unknown) {
  return fields(value, ["id", "displayName", "username"])
}

/** Whitelist scalars too: an unexpected nested object cannot smuggle metadata. */
function fields(value: unknown, keys: readonly string[]) {
  const result: Record<string, JsonValue> = {}
  if (!isRecord(value)) return result
  for (const key of keys) {
    const field = value[key]
    if (typeof field === "string")
      result[key] = redactEmails(field).slice(0, 200)
    if (typeof field === "number" || typeof field === "boolean")
      result[key] = field
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function redactEmails(text: string) {
  // Seerr can fall back to an email in displayName or username as well.
  return text.replace(/[^\s@<>"\\]+@[^\s@<>"\\]+/g, "[email omitted]")
}
