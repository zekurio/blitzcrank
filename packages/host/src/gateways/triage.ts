import type {
  ClassifierChoiceQuestion,
  ClassifierResult,
} from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Data, Effect, Option } from "effect"

export class TriageError extends Data.TaggedError("TriageError")<{
  /** Why there is no verdict. Never the provider's message, which may echo input. */
  reason: "aborted" | "error" | "malformed" | "request" | "timeout"
}> {}

const LABELS = ["stack", "chat", "other"] as const
type Label = (typeof LABELS)[number]

export interface Verdict {
  /** The most likely label. */
  label: Label
  /** How likely the message asks about the media server, from 0 to 1. */
  stack: number
}

export type Triage = (message: string) => Effect.Effect<Verdict, TriageError>

const MAX_MESSAGE_CHARS = 4_000
const TIMEOUT = "15 seconds"

// `chat` exists because a media channel talks about media: "did you see the
// new season?" is on topic for the room and still asks the bot for nothing.
const CRITERIA: Record<Label, string> = {
  stack:
    "Asks for help with the media server or reports a problem with it: requesting a movie or show, downloads, playback, streaming, subtitles, audio tracks, quality, missing episodes or files, Seerr, Sonarr, Radarr, SABnzbd, or Jellyfin.",
  chat: "Talks about movies, shows, or music, or chats with other members, without asking the server or the bot for anything.",
  other: "Anything else.",
}

/**
 * The classifier that decides whether a chat message opens a thread. It
 * answers with labels and probabilities and writes no text, so nothing it
 * returns can reach the chat. Resolving the model at startup turns a typo or a
 * missing key into a failed boot instead of a bot that ignores everyone.
 *
 * `naming.setting` is the env var that holds `spec`, named in those startup
 * errors. `naming.platform` is the chat platform the question says the
 * message was posted on.
 */
export function createTriage(
  runtime: ModelRuntime,
  spec: string,
  naming: { setting: string; platform: string },
): Triage {
  const slash = spec.indexOf("/")
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`${naming.setting} must be provider/model, got "${spec}"`)
  }
  const provider = spec.slice(0, slash)
  const id = spec.slice(slash + 1)
  const model = runtime.getModelOfType("classifier", provider, id)
  if (!model) {
    throw new Error(
      runtime.getModel(provider, id)
        ? `${naming.setting} ${spec} is a chat model; triage needs a classifier such as opencode/jev-1.13`
        : `Unknown classifier model: ${spec}`,
    )
  }
  if (!runtime.getProviderAuthStatus(provider).configured) {
    throw new Error(
      `${naming.setting} ${spec} has no credentials; set the ${provider} API key or log in`,
    )
  }
  const topic: ClassifierChoiceQuestion = {
    type: "choice",
    instructions: `A member posted this message in a ${naming.platform} channel where people can ask a bot for help with their private media server. Decide what the message is.`,
    criteria: CRITERIA,
  }
  return (message) =>
    Effect.tryPromise({
      try: (signal) =>
        runtime.classify(
          model,
          {
            state: { message: message.slice(0, MAX_MESSAGE_CHARS) },
            questions: { topic },
          },
          { signal },
        ),
      catch: () => new TriageError({ reason: "request" }),
    }).pipe(
      Effect.timeoutOption(TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new TriageError({ reason: "timeout" })),
          onSome: verdictEffect,
        }),
      ),
    )
}

function verdictEffect(
  result: ClassifierResult,
): Effect.Effect<Verdict, TriageError> {
  if (result.stopReason !== "stop") {
    return Effect.fail(new TriageError({ reason: result.stopReason }))
  }
  const answer = result.answers.topic
  if (answer?.type !== "choice") {
    return Effect.fail(new TriageError({ reason: "malformed" }))
  }
  const label = LABELS.find((known) => known === answer.choice)
  const stack = answer.probabilities.stack
  // The SDK only checks for a finite number, and a stack of 2 would clear any
  // threshold.
  if (
    label === undefined ||
    stack === undefined ||
    !Number.isFinite(stack) ||
    stack < 0 ||
    stack > 1
  ) {
    return Effect.fail(new TriageError({ reason: "malformed" }))
  }
  return Effect.succeed({ label, stack })
}
