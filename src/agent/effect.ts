import { Data } from "effect"

/** Failures at the pi SDK boundary retain their original cause. */
export class SdkError extends Data.TaggedError("SdkError")<{
  message: string
  cause: unknown
}> {}
