/**
 * Per-run state for one agent run against one issue.
 *
 * Because the tool layer runs in-process, we can *enforce* what the legacy
 * deployment could only ask a reviewer to check:
 *  - evidence gates: a mutation's target ID must have appeared in a GET
 *    response earlier in this run (no hallucinated/guessed IDs),
 *  - per-run mutation budgets (hard caps, deletions counted separately),
 *  - file-level evidence: which media files were actually probed this run, so
 *    a bulk replacement cannot be justified by release-name metadata alone.
 */

const MAX_EVIDENCE_ENTRIES = 24
const MAX_EVIDENCE_BODY_CHARS = 80_000
const MAX_PROBED_PATHS = 64

export interface RunLimits {
  maxMutations: number
  maxDeletes: number
}

const DEFAULT_LIMITS: RunLimits = { maxMutations: 5, maxDeletes: 2 }

interface EvidenceEntry {
  service: string
  path: string
  body: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export class RunContext {
  private readonly evidence: EvidenceEntry[] = []
  private readonly probed: string[] = []
  private mutations = 0
  private deletes = 0

  constructor(private readonly limits: RunLimits = DEFAULT_LIMITS) {}

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

  /** True when this exact file, or a directory containing it, was probed. */
  sawProbe(filePath: string): boolean {
    return this.probed.some(
      (probe) => probe === filePath || filePath.startsWith(`${probe}/`),
    )
  }

  requireEvidence(service: string, value: string | number, hint: string): void {
    if (!this.sawValue(service, value)) {
      throw new Error(
        `evidence gate: ${hint} ${value} did not appear in any ${service} read this run; ` +
          `fetch it first (do not guess IDs)`,
      )
    }
  }

  noteMutation(kind: "mutate" | "delete"): void {
    if (kind === "delete" && this.deletes >= this.limits.maxDeletes) {
      throw new Error(
        `mutation budget: at most ${this.limits.maxDeletes} deletions per run; ask the operator instead`,
      )
    }
    if (this.mutations >= this.limits.maxMutations) {
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
