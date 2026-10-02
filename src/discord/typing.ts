import { Effect, Schedule } from "effect"

/** Typing belongs to the active run and cannot delay or fail its answer. */
export function withTypingEffect<A, E, R>(
  work: Effect.Effect<A, E, R>,
  typing: () => Effect.Effect<void, unknown>,
): Effect.Effect<A, E, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.suspend(typing).pipe(
        Effect.timeout("2 seconds"),
        Effect.catchCause(() => Effect.void),
        Effect.repeat(Schedule.spaced("5 seconds")),
        Effect.interruptible,
        Effect.forkScoped,
      )
      return yield* work
    }),
  )
}
