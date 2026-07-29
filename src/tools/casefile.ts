import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import { clampEntries, clampEntry, type CaseFile } from "../casefile.js"
import { textResult } from "./common.js"

/**
 * The agent's own memory between runs. It replaces the stored summary
 * wholesale rather than appending, so the model prunes what stopped being
 * true instead of accumulating a transcript; the host caps entry count and
 * length, because this text is re-read at the start of every later run.
 *
 * Only the summary is writable: run history, spend, and revisit chain are
 * host-written facts the agent must not be able to edit.
 */
export function buildCaseFileTool(file: CaseFile): ToolDefinition {
  return defineTool({
    name: "update_case_file",
    label: "Record durable findings",
    description:
      "Store what this run established about the issue, so the next run starts from it instead of re-deriving " +
      "everything and re-reading old transcripts. Call it once before your final response whenever you learned " +
      "something durable: verified facts with the evidence behind them, hypotheses you disproved, and what is " +
      "still open. It replaces the previous summary, so restate what still holds and drop what no longer does. " +
      "Never store secrets, raw JSON, or user-identifying details.",
    parameters: Type.Object({
      hypothesis: Type.Optional(
        Type.String({
          description:
            "Current best explanation in one line, or omit when the cause is established",
        }),
      ),
      facts: Type.Array(Type.String(), {
        description:
          "Verified facts with their evidence, e.g. 'series id 483; all 24 episode files carry a single jpn audio stream (media_probe)'",
      }),
      ruledOut: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Explanations already disproved, so the next run does not retry them",
        }),
      ),
      openQuestions: Type.Optional(
        Type.Array(Type.String(), {
          description: "What still needs an answer, and from which source",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
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
