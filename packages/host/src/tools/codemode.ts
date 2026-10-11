import {
  CodemodeSandbox,
  renderDeclarations,
  type CodemodeResult,
  type CodemodeTool,
} from "@earendil-works/pi-codemode"
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Type } from "typebox"

import { MAX_RESULT_CHARS } from "./common.ts"

export const CODEMODE_TOOL = "codemode"

/** One script's whole budget, including the time its tool calls take. */
const SCRIPT_TIMEOUT_MS = 120_000

/** A script may loop over a frame tool; the model still sees a bounded set. */
const MAX_IMAGES = 6

type ScriptContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

/**
 * Runs a model-written script whose only capability is calling `readOnly`.
 *
 * Replay-safe by construction: every tool handed to the sandbox was built from
 * an MCP tool annotated `readOnlyHint`, so rerunning an interrupted script
 * repeats reads and nothing else. Never pass a tool that can write here.
 */
export function buildCodemodeTool(
  readOnly: CodemodeTool[],
  modelInput: readonly ("text" | "image")[] | undefined,
): ToolRegistration {
  const plans = readOnly.some((tool) => tool.name.endsWith("_plan"))
  return defineTool({
    name: CODEMODE_TOOL,
    replay: "safe",
    description: `Run a JavaScript script that reads live state through the tools declared below. Calls made inside the script and their results stay out of the conversation. Only the script's output and return value come back.

- \`code\` is the body of an async function: \`await\` and \`return\` work at the top level.
- Call a tool as \`await tools.<name>(args)\`. A failed call throws an Error carrying the tool's message.
- Produce output with \`text(value)\` or \`return value\`. Use \`console.log\` for notes.
- Results are cut at ${MAX_RESULT_CHARS} characters. Filter and project large results in the script before returning them.
- Run independent reads with \`Promise.allSettled\` so one failed source does not hide the others.
- A tool that returns images resolves to its content blocks. Pass each \`{ type: "image" }\` block to \`image(block)\` to see that frame. At most ${MAX_IMAGES} images come back per call.
- Scripts cannot write anything.${plans ? " A write is a `<service>_plan` call, which a script may make, followed by the matching `<service>_apply` tool called directly with the plan's `planId`." : ""}
- There are no timers, network, filesystem, or imports. A script runs for at most ${SCRIPT_TIMEOUT_MS / 1000} seconds.

\`\`\`ts
${renderDeclarations({ tools: readOnly })}
\`\`\``,
    parameters: Type.Object({
      code: Type.String({
        description:
          "JavaScript async function body. Read with `await tools.<name>(args)`, then `return` or `text()` only what you need.",
      }),
    }),
    async execute(params, _api, context) {
      const sandbox = new CodemodeSandbox({
        tools: readOnly,
        timeoutMs: SCRIPT_TIMEOUT_MS,
      })
      try {
        const result = await sandbox.execute(
          params.code,
          context.abortSignal ? { signal: context.abortSignal } : {},
        )
        return {
          content: scriptContent(
            result,
            modelInput?.includes("image") === true,
          ),
          isError: !result.ok,
          details: { calls: result.calls.length, ok: result.ok },
        }
      } finally {
        // The worker thread must not outlive the call, whatever ended it.
        await sandbox.close()
      }
    },
  })
}

function scriptContent(
  result: CodemodeResult,
  acceptsImages: boolean,
): ScriptContent[] {
  const items: ScriptContent[] = [
    // First, so cutting a long partial output can never hide the failure.
    ...(result.ok
      ? []
      : [
          textItem(
            `Script failed (${result.error.kind}): ${result.error.message}`,
          ),
        ]),
    ...result.output.map((item) =>
      item.type === "text" ? textItem(item.text) : item,
    ),
    ...(result.ok && result.value !== undefined
      ? [
          textItem(
            typeof result.value === "string"
              ? result.value
              : JSON.stringify(result.value),
          ),
        ]
      : []),
  ]
  const viewable = acceptsImages ? MAX_IMAGES : 0
  const content: ScriptContent[] = []
  let chars = 0
  let cut = 0
  let images = 0
  for (const item of items) {
    if (item.type === "image") {
      images += 1
      if (images <= viewable) content.push(item)
      continue
    }
    const kept = item.text.slice(0, MAX_RESULT_CHARS - chars)
    chars += kept.length
    cut += item.text.length - kept.length
    if (kept.length > 0) content.push(textItem(kept))
  }
  if (cut > 0)
    content.push(
      textItem(
        `... [truncated ${cut} chars — filter in the script and return less]`,
      ),
    )
  if (images > viewable)
    content.push(
      textItem(
        acceptsImages
          ? `[${images - viewable} more images omitted: at most ${MAX_IMAGES} come back per call]`
          : `[${images} images omitted: this model cannot view images]`,
      ),
    )
  if (content.length === 0)
    content.push(
      textItem("(no output: use text() or return to send results back)"),
    )
  return content
}

function textItem(text: string): ScriptContent {
  return { type: "text", text }
}
