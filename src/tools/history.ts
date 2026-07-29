import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

import { StringEnum } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import { textResult } from "./common.js"

/**
 * Search persisted run transcripts (issues + automations) for prior related
 * investigations. Ported from the legacy thread_history_search: results are
 * clues, never authority; the current run's own transcript is always excluded.
 */

const MAX_FILES = 1000

async function collectFiles(root: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) await collectFiles(full, out)
    else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) out.push(full)
  }
}

function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase()
  const idx = terms.map((t) => lower.indexOf(t)).find((i) => i >= 0) ?? 0
  const start = Math.max(0, idx - 240)
  return text
    .slice(start, Math.min(text.length, idx + 760))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700)
}

export function buildHistoryTool(
  sessionsRoot: string,
  currentSessionFile: { current: string | undefined },
): ToolDefinition {
  return defineTool({
    name: "thread_history_search",
    label: "Search run history",
    description:
      "Search prior blitzcrank run transcripts (issue runs and automation runs) for similar investigations or fixes on OTHER " +
      "items. Returns matching snippets only. What this issue already established is in your case file, at the top of this run " +
      "— never go looking for it here, and never try to read transcript files. Treat results as clues and validate live state.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search terms such as a title, error, queue/import symptom, or prior fix",
      }),
      source: Type.Optional(
        StringEnum(["all", "issues", "automations"] as const),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params) {
      const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean)
      if (terms.length === 0) throw new Error("query is required")
      const limit = params.limit ?? 5
      const source = params.source ?? "all"

      const roots =
        source === "all"
          ? [
              path.join(sessionsRoot, "issues"),
              path.join(sessionsRoot, "automations"),
            ]
          : [path.join(sessionsRoot, source)]
      const files: string[] = []
      for (const root of roots) await collectFiles(root, files)

      const results: Array<Record<string, unknown>> = []
      for (const file of files) {
        if (currentSessionFile.current && file === currentSessionFile.current)
          continue
        let text: string
        try {
          text = await readFile(file, "utf8")
        } catch {
          continue
        }
        const score = terms.reduce(
          (sum, term) => sum + (text.toLowerCase().includes(term) ? 1 : 0),
          0,
        )
        if (score <= 0) continue
        const info = await stat(file).catch(() => undefined)
        // Deliberately no file path: handing one out invites the model to page
        // through raw JSONL with `read`, which is how a follow-up run once cost
        // more than the investigation it was recovering.
        results.push({
          score,
          modified: info?.mtime.toISOString(),
          snippet: snippet(text, terms),
        })
      }
      results.sort((a, b) => Number(b.score) - Number(a.score))
      return textResult(
        { query: params.query, results: results.slice(0, limit) },
        { action: "thread_history_search", matches: results.length },
      )
    },
  })
}
