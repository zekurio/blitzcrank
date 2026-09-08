import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"

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

export function storageCheck<A>(
  operation: () => A,
): Effect.Effect<A, StorageError> {
  return Effect.try({
    try: operation,
    catch: (cause) => new StorageError({ cause }),
  })
}

/** Finish write-then-rename before releasing a writer on interruption. */
export function writeAtomic(
  target: string,
  body: string,
): Effect.Effect<void, StorageError> {
  return Effect.gen(function* () {
    yield* storageIO(() => mkdir(path.dirname(target), { recursive: true }))
    const tmp = `${target}.tmp`
    yield* storageIO(() => writeFile(tmp, body, "utf8"))
    yield* storageIO(() => rename(tmp, target))
  }).pipe(Effect.uninterruptible)
}
