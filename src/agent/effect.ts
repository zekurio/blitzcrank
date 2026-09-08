import { Data, Effect } from "effect"

/** Failures at the pi and Discord SDK boundaries retain their original cause. */
export class SdkError extends Data.TaggedError("SdkError")<{
  message: string
  cause: unknown
}> {}

export function sdkPromise<A>(
  run: () => PromiseLike<A>,
): Effect.Effect<A, SdkError> {
  return Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) =>
      new SdkError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  })
}
