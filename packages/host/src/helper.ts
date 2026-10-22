import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Data, Effect, Option } from "effect"

import { parseModelSpec } from "./agent/durable-model.ts"

export class HelperError extends Data.TaggedError("HelperError")<{
  /** Why there is no text. Never the provider's message, which may echo input. */
  reason: "aborted" | "empty" | "error" | "length" | "request" | "timeout"
}> {}

/** One small job for the helper model. */
export interface HelperPrompt {
  /** What to do with the input. It goes in as the system prompt. */
  instructions: string
  /** The text to work on, untrusted. It goes in as the only user message. */
  input: string
  /** The most the answer may run to. Thinking, if the spec asks for it, comes on top. */
  maxTokens: number
}

/**
 * The host's chat model for small text jobs outside a run, such as naming a
 * thread. One instruction and one input go in, and one short text comes out:
 * it sees no tools, no conversation, and nothing a run knows. The caller
 * decides where the text goes and cleans it up first.
 */
export interface Helper {
  textEffect(prompt: HelperPrompt): Effect.Effect<string, HelperError>
}

/** A small job that takes longer than this is not small. */
const TIMEOUT = "15 seconds"
const MAX_INPUT_CHARS = 4_000

/**
 * Resolving the model at startup turns a typo or a missing key into a failed
 * boot instead of a failure on every call.
 */
export function createHelper(runtime: ModelRuntime, spec: string): Helper {
  const parsed = parseModelSpec(spec)
  const model = runtime.getModel(parsed.provider, parsed.modelId)
  if (!model) {
    throw new Error(
      runtime.getModelOfType("classifier", parsed.provider, parsed.modelId)
        ? `BLITZCRANK_HELPER_MODEL ${spec} is a classifier; the helper needs a chat model`
        : `Unknown helper model: ${spec}`,
    )
  }
  if (!runtime.getProviderAuthStatus(parsed.provider).configured) {
    throw new Error(
      `BLITZCRANK_HELPER_MODEL ${spec} has no credentials; set the ${parsed.provider} API key or log in`,
    )
  }
  const thinking =
    parsed.thinkingLevel === "off" ? {} : { reasoning: parsed.thinkingLevel }
  return {
    textEffect: (prompt) =>
      Effect.tryPromise({
        try: (signal) =>
          runtime.completeSimple(
            model,
            {
              systemPrompt: prompt.instructions,
              messages: [
                {
                  role: "user",
                  content: prompt.input.slice(0, MAX_INPUT_CHARS),
                  timestamp: Date.now(),
                },
              ],
            },
            { signal, maxTokens: prompt.maxTokens, ...thinking },
          ),
        catch: () => new HelperError({ reason: "request" }),
      }).pipe(
        Effect.timeoutOption(TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new HelperError({ reason: "timeout" })),
            onSome: textEffect,
          }),
        ),
      ),
  }
}

/** The answer's text, thinking left out. */
function textEffect(
  message: AssistantMessage,
): Effect.Effect<string, HelperError> {
  if (message.stopReason !== "stop") {
    return Effect.fail(
      new HelperError({
        reason:
          message.stopReason === "length" || message.stopReason === "aborted"
            ? message.stopReason
            : "error",
      }),
    )
  }
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim()
  if (!text) return Effect.fail(new HelperError({ reason: "empty" }))
  return Effect.succeed(text)
}
