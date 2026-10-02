/**
 * Directive protocol from the legacy deployment: the agent's final response
 * starts with an internal directive block, then a blank line, then the public
 * Seerr comment (possibly empty).
 *
 *   RESOLVE_ISSUE: yes|no
 *   REVISIT_IN: 45m            (optional, Go duration, clamped 10m-48h)
 *   REVISIT_REASON: one line   (required with REVISIT_IN)
 *
 *   Public comment...
 */

export interface Directives {
  resolve: boolean
  revisitInMs: number | undefined
  revisitReason: string | undefined
  comment: string
  /** True when the header is invalid; all actions and public text are withheld. */
  malformed: boolean
}

const MIN_REVISIT_MS = 10 * 60 * 1000
const MAX_REVISIT_MS = 48 * 60 * 60 * 1000

/** Parse a Go-style duration like "45m", "2h30m", "90s". */
export function parseGoDuration(value: string): number | undefined {
  const match = value.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (!match || (!match[1] && !match[2] && !match[3])) return undefined
  const [, h, m, s] = match
  const ms =
    (Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000
  return Number.isFinite(ms) ? ms : undefined
}

function clampRevisit(ms: number): number {
  return Math.min(MAX_REVISIT_MS, Math.max(MIN_REVISIT_MS, ms))
}

export function parseDirectives(finalText: string): Directives {
  const malformed: Directives = {
    resolve: false,
    revisitInMs: undefined,
    revisitReason: undefined,
    comment: "",
    malformed: true,
  }
  let text = finalText.trim()
  // Tolerate a fenced response (` ```text ... ``` `).
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/)
  if (fence) text = fence[1]!.trim()

  const lines = text.split("\n")
  const first = lines[0]?.trim() ?? ""
  const resolveMatch = first.match(/^RESOLVE_ISSUE:\s*(yes|no)\s*$/i)
  if (!resolveMatch) return malformed

  let revisitInMs: number | undefined
  let revisitReason: string | undefined
  let index = 1
  for (; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line === "") break
    const revisitIn = line.match(/^REVISIT_IN:\s*(\S+)\s*$/i)
    if (revisitIn) {
      if (revisitInMs !== undefined) return malformed
      const parsed = parseGoDuration(revisitIn[1]!)
      if (parsed === undefined) return malformed
      revisitInMs = clampRevisit(parsed)
      continue
    }
    const reason = line.match(/^REVISIT_REASON:\s*(.+)$/i)
    if (reason) {
      if (revisitReason !== undefined) return malformed
      revisitReason = reason[1]!.trim()
      continue
    }
    // Every nonempty line before the separator must be a valid header.
    return malformed
  }

  if ((revisitInMs === undefined) !== (revisitReason === undefined))
    return malformed

  const comment = lines.slice(index).join("\n").trim()
  // A blank line cannot turn a split or contradictory header into public text.
  if (/^\s*(?:RESOLVE_ISSUE|REVISIT_IN|REVISIT_REASON)\b/im.test(comment))
    return malformed

  return {
    resolve: resolveMatch[1]!.toLowerCase() === "yes",
    revisitInMs,
    revisitReason,
    comment,
    malformed: false,
  }
}
