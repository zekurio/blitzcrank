/**
 * Evidence and limit state for one agent run.
 *
 * Because the tool layer runs in-process, we can *enforce* what the legacy
 * deployment could only ask a reviewer to check:
 *  - evidence gates: a mutation's target ID must have appeared in a GET
 *    response the agent actually made (no hallucinated/guessed IDs),
 *  - a cumulative deletion ceiling,
 *  - file-level evidence: which media files were actually probed, so a bulk
 *    replacement cannot be justified by release-name metadata alone.
 *
 * For issue runs the evidence store is *carried across* the events of one
 * issue, matching the agent session that is likewise resumed: the gate exists
 * to stop fabricated IDs, and an ID that was real yesterday was not fabricated
 * today. Arr IDs are autoincrement and are not recycled, SAB `nzo_id`s are
 * random and Anvil job ids are UUIDs, so a stale ID resolves to the same
 * object or 404s — it cannot silently address a different one.
 */

const MAX_EVIDENCE_ENTRIES = 24
const MAX_EVIDENCE_BODY_CHARS = 80_000
const MAX_PROBED_PATHS = 64

export interface RunLimits {
  /**
   * Mutation ceiling, or undefined for none. Issue runs pass undefined: a
   * fixed count cannot fit both "wrong subtitle language" and "twelve episodes
   * stuck in the queue", and the real boundary is the typed-tool surface plus
   * the evidence gates, not a counter. Automations keep a ceiling because
   * nobody asked for that run.
   */
  maxMutations: number | undefined
  /**
   * Deletion ceiling. Counted cumulatively across every run on the same issue,
   * because deletions are the one action with no undo: Arr file deletes remove
   * the only copy and SAB `deleteFiles` throws away a finished download. A
   * per-event cap reset on every comment, so the issue-wide total was
   * unbounded — this is the axis where "stop and ask a human" is correct.
   */
  maxDeletes: number
}

const DEFAULT_LIMITS: RunLimits = { maxMutations: undefined, maxDeletes: 5 }

export interface EvidenceEntry {
  service: string
  path: string
  body: string
}

/** Evidence carried between the runs of one issue. */
export interface EvidenceSnapshot {
  evidence: EvidenceEntry[]
  probed: string[]
}

export interface RunContextInit {
  limits?: RunLimits | undefined
  /** Reads and probes recorded by earlier runs on the same issue. */
  prior?: EvidenceSnapshot | undefined
  /** Deletions earlier runs on this issue already spent. */
  priorDeletes?: number | undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export class RunContext {
  private readonly evidence: EvidenceEntry[]
  private readonly probed: string[]
  private readonly limits: RunLimits
  private readonly priorDeletes: number
  private mutations = 0
  private deletes = 0

  constructor(init: RunContextInit = {}) {
    this.limits = init.limits ?? DEFAULT_LIMITS
    this.evidence = [...(init.prior?.evidence ?? [])]
    this.probed = [...(init.prior?.probed ?? [])]
    this.priorDeletes = init.priorDeletes ?? 0
  }

  /** Everything worth carrying into the next run on this issue. */
  get snapshot(): EvidenceSnapshot {
    return { evidence: [...this.evidence], probed: [...this.probed] }
  }

  recordRead(service: string, path: string, body: string): void {
    this.evidence.push({
      service,
      path,
      body: body.slice(0, MAX_EVIDENCE_BODY_CHARS),
    })
    if (this.evidence.length > MAX_EVIDENCE_ENTRIES) {
      this.evidence.splice(0, this.evidence.length - MAX_EVIDENCE_ENTRIES)
    }
  }

  sawValue(service: string, value: string | number): boolean {
    const text = String(value)
    // Word boundaries only make sense for purely alphanumeric values (IDs);
    // paths and other punctuated strings use exact substring matching.
    if (/^[\w-]+$/.test(text)) {
      const pattern = new RegExp(`\\b${escapeRegExp(text)}\\b`)
      return this.evidence.some(
        (e) => e.service === service && pattern.test(e.body),
      )
    }
    return this.evidence.some(
      (e) => e.service === service && e.body.includes(text),
    )
  }

  /**
   * Records that a media file (or the directory it was found in) was inspected
   * with ffprobe. Only paths are kept — probe *contents* stay out of the
   * evidence store because stream titles are attacker-controllable text and
   * must never satisfy an ID evidence gate.
   */
  recordProbe(...paths: string[]): void {
    for (const path of paths) {
      if (path.length > 0 && !this.probed.includes(path)) this.probed.push(path)
    }
    if (this.probed.length > MAX_PROBED_PATHS) {
      this.probed.splice(0, this.probed.length - MAX_PROBED_PATHS)
    }
  }

  /**
   * True when a path, or the directory it sits in, appeared in a service read
   * on this issue. Probing is filesystem access driven by model input, so the target
   * must come from a service's own answer (Arr file path/outputPath, SABnzbd
   * storage, Jellyfin Path) rather than from issue text or reconstruction.
   */
  sawPathInAnyRead(filePath: string): boolean {
    const parent = filePath.slice(0, filePath.lastIndexOf("/"))
    return [filePath, parent].some(
      (candidate) =>
        candidate.length > 1 &&
        this.evidence.some((entry) => entry.body.includes(candidate)),
    )
  }

  /** True when this exact file, or a directory containing it, was probed. */
  sawProbe(filePath: string): boolean {
    return this.probed.some(
      (probe) => probe === filePath || filePath.startsWith(`${probe}/`),
    )
  }

  requireEvidence(service: string, value: string | number, hint: string): void {
    if (!this.sawValue(service, value)) {
      throw new Error(
        `evidence gate: ${hint} ${value} did not appear in any ${service} read on this issue; ` +
          `fetch it first (do not guess IDs)`,
      )
    }
  }

  noteMutation(kind: "mutate" | "delete"): void {
    if (
      kind === "delete" &&
      this.priorDeletes + this.deletes >= this.limits.maxDeletes
    ) {
      throw new Error(
        `deletion budget: at most ${this.limits.maxDeletes} deletions for this issue ` +
          `(${this.priorDeletes} already spent by earlier runs); ask the operator instead`,
      )
    }
    if (
      this.limits.maxMutations !== undefined &&
      this.mutations >= this.limits.maxMutations
    ) {
      throw new Error(
        `mutation budget: at most ${this.limits.maxMutations} mutations per run; ask the operator instead`,
      )
    }
    this.mutations += 1
    if (kind === "delete") this.deletes += 1
  }

  get counts(): { mutations: number; deletes: number } {
    return { mutations: this.mutations, deletes: this.deletes }
  }
}
