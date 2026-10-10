import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Type } from "typebox"

import {
  clampEntries,
  clampEntry,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  type CaseFile,
} from "../casefile.ts"
import { textResult } from "./common.ts"

/**
 * The agent's own memory between runs. It replaces the stored summary
 * wholesale rather than appending, so the model prunes what stopped being
 * true instead of accumulating a transcript. Entry count and length are capped
 * because this text is re-read at the start of every later run. The schema
 * declares the caps so an oversized entry fails visibly instead of being
 * silently cut by the host clamp.
 *
 * Only the summary is writable: run history, spend, and revisit chain are
 * host-written facts the agent must not be able to edit.
 */
export function buildCaseFileTool(file: CaseFile): ToolRegistration {
  return defineTool({
    name: "update_case_file",
    description:
      "Store what this run established about the issue, so the next run starts from it instead of re-deriving " +
      "everything and re-reading old transcripts. Call it once before finish_issue whenever you learned " +
      "something durable: verified facts with the evidence behind them, hypotheses you disproved, and what is " +
      "still open. It replaces the previous summary, so restate what still holds and drop what no longer does. " +
      "Never store secrets, raw JSON, or user-identifying details.",
    parameters: Type.Object({
      hypothesis: Type.Optional(
        entry(
          "Current best explanation in one line, or omit when the cause is established",
        ),
      ),
      facts: entries(
        "Verified facts with their evidence, e.g. 'series id 483; all 24 episode files carry a single jpn audio stream (media_probe)'",
      ),
      ruledOut: Type.Optional(
        entries(
          "Explanations already disproved, so the next run does not retry them",
        ),
      ),
      openQuestions: Type.Optional(
        entries("What still needs an answer, and from which source"),
      ),
    }),
    async execute(params) {
      file.summary = {
        hypothesis: clampEntry(params.hypothesis),
        facts: clampEntries(params.facts),
        ruledOut: clampEntries(params.ruledOut),
        openQuestions: clampEntries(params.openQuestions),
      }
      return textResult(
        {
          stored: true,
          facts: file.summary.facts.length,
          ruledOut: file.summary.ruledOut.length,
          openQuestions: file.summary.openQuestions.length,
        },
        { action: "update_case_file" },
      )
    },
  })
}

function entry(description: string) {
  return Type.String({ maxLength: MAX_ENTRY_CHARS, description })
}

function entries(description: string) {
  return Type.Array(Type.String({ maxLength: MAX_ENTRY_CHARS }), {
    maxItems: MAX_ENTRIES,
    description: `${description}. At most ${MAX_ENTRIES} entries of ${MAX_ENTRY_CHARS} characters each.`,
  })
}
