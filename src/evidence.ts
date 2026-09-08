import { readFile, rm } from "node:fs/promises"
import path from "node:path"

import { Effect } from "effect"

import type { JsonValue } from "./services/http.ts"
import { storageCheck, storageIO, writeAtomic } from "./storage.ts"
import type { StorageError } from "./storage.ts"
import type { EvidenceIdentity, EvidenceSnapshot } from "./tools/context.ts"

interface EvidenceFileData {
  evidence: EvidenceSnapshot["evidence"]
  identities: JsonValue[]
  probed: string[]
}

/** Atomic durable storage for one issue or conversation's evidence snapshot. */
export class EvidenceStore {
  constructor(
    private readonly dir: string,
    private readonly logPrefix: string,
  ) {}

  loadEffect(
    scopeId: string,
  ): Effect.Effect<EvidenceSnapshot | undefined, StorageError> {
    return Effect.gen({ self: this }, function* () {
      const target = yield* storageCheck(() => this.file(scopeId))
      const raw = yield* storageIO(() => readFile(target, "utf8")).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (raw === undefined) return undefined
      return yield* storageCheck(() => {
        // SAFETY: Array presence and identity members are checked before use.
        const parsed = JSON.parse(raw) as Partial<EvidenceFileData>
        if (!Array.isArray(parsed.evidence)) return undefined
        const identities = Array.isArray(parsed.identities)
          ? parsed.identities.filter(isEvidenceIdentity)
          : []
        return {
          evidence: parsed.evidence,
          identities,
          probed: Array.isArray(parsed.probed) ? parsed.probed : [],
        }
      }).pipe(
        Effect.catch(() => {
          console.warn(
            `[${this.logPrefix}:${scopeId}] unreadable evidence file; ignoring it`,
          )
          return Effect.succeed(undefined)
        }),
      )
    })
  }

  saveEffect(
    scopeId: string,
    snapshot: EvidenceSnapshot,
  ): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function* () {
      const target = yield* storageCheck(() => this.file(scopeId))
      const body = yield* storageCheck(() => JSON.stringify(snapshot))
      yield* writeAtomic(target, body)
    })
  }

  forgetEffect(scopeId: string): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function* () {
      const target = yield* storageCheck(() => this.file(scopeId))
      yield* storageIO(() => rm(target, { force: true }))
    })
  }

  load(scopeId: string): Promise<EvidenceSnapshot | undefined> {
    return Effect.runPromise(this.loadEffect(scopeId))
  }

  save(scopeId: string, snapshot: EvidenceSnapshot): Promise<void> {
    return Effect.runPromise(this.saveEffect(scopeId, snapshot))
  }

  forget(scopeId: string): Promise<void> {
    return Effect.runPromise(this.forgetEffect(scopeId))
  }

  private file(scopeId: string): string {
    if (!/^[\w-]{1,64}$/.test(scopeId)) {
      throw new Error(`refusing to use "${scopeId}" as an evidence file name`)
    }
    return path.join(this.dir, `${scopeId}.evidence.json`)
  }
}

function isEvidenceIdentity(
  value: JsonValue,
): value is JsonValue & EvidenceIdentity {
  return isJsonObject(value) && isString(value.service) && isString(value.value)
}

function isJsonObject(
  value: JsonValue,
): value is { [key: string]: JsonValue | undefined } {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string"
}
