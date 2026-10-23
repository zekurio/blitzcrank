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
  /** The other labels' probabilities and the model's confidence, for the log only. */
  chat: number | undefined
  other: number | undefined
  confidence: number
}

export type Triage = (message: string) => Effect.Effect<Verdict, TriageError>

const MAX_MESSAGE_CHARS = 4_000
const TIMEOUT = "15 seconds"

// `chat` exists because a media channel talks about media: "did you see the
// new season?" is on topic for the room and still asks the bot for nothing.
// An unmentioned message rarely asks outright, so `stack` takes a remark or
// complaint as readily as a question, and `chat` keeps other services,
// cinemas, and thanks from reading as one.
const CRITERIA: Record<Label, string> = {
  stack:
    "Wants something from this media server or says something is wrong with it, even as a short remark, complaint, or question: a movie or show they want added, whether or when a title or episode is on the server, an earlier request that has not shown up, something that will not play, buffers, stutters, or looks bad, wrong or missing subtitles or audio, a stuck or failed download, or Seerr, Sonarr, Radarr, SABnzbd, or Jellyfin misbehaving.",
  chat: "Talks about movies, shows, or music, recommends or reviews them, or chats with other members, without wanting anything from the server or saying anything is wrong with it. Questions about cinemas, release dates, or other streaming services, thanks, and reports that something works again are chat.",
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
    instructions: `A member posted this message in a ${naming.platform} channel where people can ask a bot for help with their private media server. Members write casually, in any language, often in lowercase, with typos, and without tagging the bot or asking a direct question. Decide what the message is.`,
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
  return Effect.succeed({
    label,
    stack,
    chat: answer.probabilities.chat,
    other: answer.probabilities.other,
    confidence: answer.confidence,
  })
}
