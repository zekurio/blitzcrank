import type { JsonValue } from "../http.ts"
import type { JsonObject } from "../json.ts"

export const MAX_RESULT_CHARS = 30_000
export const MAX_LIST_ITEMS = 100
/** Room a list page leaves for the fields a tool puts around it. */
const LIST_HEADROOM_CHARS = 2_000
/** What one part of a write's outcome holds before it is cut. */
export const MAX_OUTCOME_PART_CHARS = 12_000

export function toText(data: JsonValue | undefined): string {
  const text = typeof data === "string" ? data : JSON.stringify(data)
  if (text === undefined) return "null"
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}\n... [truncated ${text.length - MAX_RESULT_CHARS} chars]`
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

export interface ToolResult {
  content: ContentBlock[]
  isError?: true
}

export function jsonResult(value: JsonObject): ToolResult {
  return { content: [{ type: "text", text: toText(value) }] }
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: toText(message) }], isError: true }
}

/**
 * A capped page of a list, saying how many entries exist beyond it. A page
 * too long for one result ends at the last entry that fits, so `listed` is
 * what a caller skips to read on. Like `fittingCount`, it throws rather than
 * list none of a page that has entries.
 */
export function listResult(
  items: JsonObject[],
  opts: { total?: number | undefined; offset?: number | undefined } = {},
): JsonObject {
  const offset = opts.offset ?? 0
  const page = items.slice(offset, offset + MAX_LIST_ITEMS)
  const total = opts.total ?? items.length
  const withCount = (count: number): JsonObject => ({
    total,
    listed: count,
    ...(offset > 0 ? { offset } : {}),
    ...(offset + count < total ? { truncated: true } : {}),
    items: page.slice(0, count),
  })
  return withCount(
    fittingCount(page.length, withCount, {
      headroom: LIST_HEADROOM_CHARS,
      entry: `the entry at offset ${offset}`,
    }),
  )
}

/**
 * The most leading entries of a list that `fits` accepts, or -1 when it
 * accepts not even a result that lists none.
 */
export function largestFitting(
  length: number,
  fits: (count: number) => boolean,
): number {
  for (let count = length; count >= 0; count--) {
    if (fits(count)) return count
  }
  return -1
}

/**
 * How many leading entries of a list still fit one tool result, given the
 * result built around them. A cut result would be invalid JSON and lose the
 * entries' closing fields, so a caller lists this many and says where the
 * rest starts.
 *
 * Throws when the list has entries and not one fits, and when the result is
 * too long with none listed. A page that lists nothing looks like one a
 * caller can read past, and reading on would return the same page.
 */
export function fittingCount(
  length: number,
  build: (count: number) => JsonObject,
  opts: { headroom?: number; entry?: string } = {},
): number {
  const limit = MAX_RESULT_CHARS - (opts.headroom ?? 0)
  const chars = (count: number) => JSON.stringify(build(count)).length
  const count = largestFitting(length, (entries) => chars(entries) <= limit)
  if (count > 0 || (count === 0 && length === 0)) return count
  throw new Error(
    count < 0
      ? `the result is ${chars(0)} characters before it lists any entry, and one result holds ${limit}`
      : `${opts.entry ?? "the first entry"} is too large to list: with it alone the result is ${chars(1)} characters, and one result holds ${limit}`,
  )
}

export function bounded(value: JsonValue): JsonValue {
  const text = JSON.stringify(value)
  if (text.length <= MAX_OUTCOME_PART_CHARS) return value
  return `${text.slice(0, MAX_OUTCOME_PART_CHARS)}... [truncated ${text.length - MAX_OUTCOME_PART_CHARS} chars]`
}
