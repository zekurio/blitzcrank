import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import type { JsonValue } from "./services/http.ts"
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

  async load(scopeId: string): Promise<EvidenceSnapshot | undefined> {
    const raw = await readFile(this.file(scopeId), "utf8").catch(
      () => undefined,
    )
    if (raw === undefined) return undefined
    try {
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
    } catch {
      console.warn(
        `[${this.logPrefix}:${scopeId}] unreadable evidence file; ignoring it`,
      )
      return undefined
    }
  }

  async save(scopeId: string, snapshot: EvidenceSnapshot): Promise<void> {
    const target = this.file(scopeId)
    await mkdir(this.dir, { recursive: true })
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(snapshot), "utf8")
    await rename(tmp, target)
  }

  async forget(scopeId: string): Promise<void> {
    await rm(this.file(scopeId), { force: true })
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
