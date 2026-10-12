import { Data, Effect } from "effect"

export class StorageError extends Data.TaggedError("StorageError")<{
  cause: unknown
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }

  get code(): string | undefined {
    return this.cause !== null &&
      typeof this.cause === "object" &&
      "code" in this.cause &&
      typeof this.cause.code === "string"
      ? this.cause.code
      : undefined
  }
}

export function storageIO<A>(
  operation: () => Promise<A>,
): Effect.Effect<A, StorageError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => new StorageError({ cause }),
  })
}
