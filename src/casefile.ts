import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

import type { EvidenceSnapshot } from "./tools/context.js"

/**
 * Per-issue case file: the durable, host-owned record of one issue.
 *
 * The agent's *conversation* now survives between runs (the pi session is
 * resumed, see `sessionFile`), so this file is no longer the only thing
 * standing between a follow-up comment and a blank slate. It stays because it
 * outranks the transcript: it is the fallback when a session file is missing
 * or unreadable, it survives compaction dropping the early turns, and it holds
 * the counters the agent must not be able to edit.
 *
 * Two writers, deliberately separated:
 *  - the agent writes `summary` through the `update_case_file` tool (what is
 *    established, what is ruled out, what is still open),
 *  - the host writes everything factual: run records, cumulative usage, the
 *    pending revisit and its chain length. The agent cannot edit those, so it
 *    cannot talk itself past the revisit cap or understate what it used.
 */

export type CaseMediaScope = "movie" | "tv" | undefined

export interface CaseSummary {
  hypothesis: string | undefined
  /** Established facts, each with the evidence it rests on. */
  facts: string[]
  /** Hypotheses already disproved; stops the next run re-deriving them. */
  ruledOut: string[]
  openQuestions: string[]
}

export interface CaseRun {
  at: string
  trigger: "webhook" | "revisit"
  mutations: number
  deletes: number
  /** `RunUsage.newTokens`: input + cache writes + output, no cache reads. */
  tokens: number
  /** Undefined on runs recorded before split usage was introduced. */
  inputTokens?: number
  /** Undefined on runs recorded before split usage was introduced. */
  outputTokens?: number
  commented: boolean
  resolved: boolean
}

export interface PendingRevisit {
  dueAt: string
  reason: string
  mediaScope: CaseMediaScope
  /** How many revisits have chained since the last user message. */
  chain: number
  /** The delay used, so a fruitless follow-up can back off. */
  delayMs: number
}

export interface CaseFile {
  issueId: string
  updatedAt: string
  summary: CaseSummary
  /**
   * The last comment actually published, host-written. Continuity must not
   * depend on the agent volunteering to call `update_case_file`, and repeating
   * an earlier answer is the most common way a follow-up wastes a run.
   */
  lastAnswer: string | undefined
  /**
   * The pi session JSONL to resume, so a follow-up comment continues the same
   * conversation instead of re-deriving it from `summary`. Host-written and
   * re-validated against the filesystem before use: a missing file makes the
   * SDK start a blank session silently rather than fail.
   */
  sessionFile: string | undefined
  runs: CaseRun[]
  /**
   * Running totals for the whole issue; shown in the comment footer.
   *
   * `tokens` accumulates `RunUsage.newTokens`, so it stays proportional to the
   * work done. Case files written before that fix carry an inflated total that
   * also counted cache reads; it stops growing wrongly rather than being
   * rewritten, because losing an issue's memory to a migration is worse than
   * one stale number.
   *
   * `deletes` counts what earlier runs destroyed. It gates nothing — issue runs
   * are uncapped — but it is the audit trail for the one class of action that
   * cannot be inspected after the fact, and it is shown to the next run.
   * Written by the host from `RunContext.counts`, never by the agent.
   */
  spend: {
    runs: number
    tokens: number
    /** Undefined on a legacy case whose historical usage cannot be split. */
    inputTokens: number | undefined
    /** Undefined on a legacy case whose historical usage cannot be split. */
    outputTokens: number | undefined
    /** Cumulative API-priced USD; undefined for legacy cases. */
    costUsd: number | undefined
    deletes: number
  }
  revisit: PendingRevisit | undefined
}

const MAX_ENTRIES = 12
const MAX_ENTRY_CHARS = 300
const MAX_RUNS = 8

export function emptyCase(issueId: string): CaseFile {
  return {
    issueId,
    updatedAt: new Date().toISOString(),
    summary: {
      hypothesis: undefined,
      facts: [],
      ruledOut: [],
      openQuestions: [],
    },
    lastAnswer: undefined,
    sessionFile: undefined,
    runs: [],
    spend: {
      runs: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      deletes: 0,
    },
    revisit: undefined,
  }
}

/**
 * Model-supplied text is capped hard and flattened to one line: this file is
 * re-read as part of a later prompt, so multi-line text could otherwise forge
 * the host-written structure around it.
 */
export function clampEntry(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const clamped = value.replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_CHARS)
  return clamped.length > 0 ? clamped : undefined
}

export function clampEntries(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values
    .map(clampEntry)
    .filter((value): value is string => value !== undefined)
    .slice(0, MAX_ENTRIES)
}

function clampSummary(summary: Partial<CaseSummary> | undefined): CaseSummary {
  return {
    hypothesis: clampEntry(summary?.hypothesis),
    facts: clampEntries(summary?.facts),
    ruledOut: clampEntries(summary?.ruledOut),
    openQuestions: clampEntries(summary?.openQuestions),
  }
}

/** Compact prompt rendering; empty when there is nothing worth carrying. */
export function renderCase(file: CaseFile): string | undefined {
  const lines: string[] = []
  if (file.summary.hypothesis) {
    lines.push(`Current hypothesis: ${file.summary.hypothesis}`)
  }
  const section = (title: string, values: string[]) => {
    if (values.length === 0) return
    lines.push(`${title}:`)
    for (const value of values) lines.push(`- ${value}`)
  }
  section("Established", file.summary.facts)
  section("Ruled out", file.summary.ruledOut)
  section("Still open", file.summary.openQuestions)
  if (file.lastAnswer) {
    lines.push(`Last answer posted to the reporter: ${file.lastAnswer}`)
  }

  const history = file.runs.slice(-4).map((run) => {
    const outcome = [
      run.mutations > 0 ? `${run.mutations} mutation(s)` : "no mutation",
      run.commented ? "commented" : "no comment",
    ].join(", ")
    return `- ${run.at} ${run.trigger}: ${outcome}`
  })
  if (history.length > 0) {
    lines.push(`Previous runs (${file.spend.runs} total):`)
    lines.push(...history)
  }
  return lines.length > 0 ? lines.join("\n") : undefined
}

export class CaseStore {
  constructor(private readonly dir: string) {}

  private file(issueId: string): string {
    if (!/^[\w-]{1,64}$/.test(issueId)) {
      throw new Error(`refusing to use "${issueId}" as a case file name`)
    }
    return path.join(this.dir, `${issueId}.json`)
  }

  private evidenceFile(issueId: string): string {
    return `${this.file(issueId).slice(0, -".json".length)}.evidence.json`
  }

  /**
   * Never throws for a damaged file: losing the memory of an issue is
   * recoverable, refusing to run it ever again is not.
   */
  async load(issueId: string): Promise<CaseFile> {
    const raw = await readFile(this.file(issueId), "utf8").catch(
      () => undefined,
    )
    if (raw === undefined) return emptyCase(issueId)
    const empty = emptyCase(issueId)
    let parsed: Partial<CaseFile> | undefined
    try {
      parsed = JSON.parse(raw) as Partial<CaseFile>
    } catch {
      console.warn(`[case:${issueId}] unreadable case file; starting fresh`)
      return empty
    }
    return {
      ...empty,
      ...parsed,
      issueId,
      // Re-clamped on the way in as well: the cap has to be a property of the
      // prompt, not only of the write path.
      summary: clampSummary(parsed.summary),
      lastAnswer: clampEntry(parsed.lastAnswer),
      sessionFile:
        typeof parsed.sessionFile === "string" ? parsed.sessionFile : undefined,
      spend: {
        ...empty.spend,
        ...parsed.spend,
        // Do not pretend a legacy combined total was all input or all output.
        inputTokens:
          typeof parsed.spend?.inputTokens === "number"
            ? parsed.spend.inputTokens
            : undefined,
        outputTokens:
          typeof parsed.spend?.outputTokens === "number"
            ? parsed.spend.outputTokens
            : undefined,
        costUsd:
          typeof parsed.spend?.costUsd === "number"
            ? parsed.spend.costUsd
            : undefined,
      },
      runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-MAX_RUNS) : [],
    }
  }

  /**
   * Evidence from earlier runs on this issue, in a sidecar file: it is bulky
   * raw service JSON, and the case file is re-read into a prompt where that
   * would be both useless and enormous.
   *
   * A damaged or missing file yields no evidence rather than throwing. That
   * fails in the safe direction — the agent must re-read before it can mutate,
   * which is exactly what the gate asks for anyway.
   */
  async loadEvidence(issueId: string): Promise<EvidenceSnapshot | undefined> {
    const raw = await readFile(this.evidenceFile(issueId), "utf8").catch(
      () => undefined,
    )
    if (raw === undefined) return undefined
    try {
      const parsed = JSON.parse(raw) as Partial<EvidenceSnapshot>
      if (!Array.isArray(parsed.evidence)) return undefined
      return {
        evidence: parsed.evidence,
        probed: Array.isArray(parsed.probed) ? parsed.probed : [],
      }
    } catch {
      console.warn(`[case:${issueId}] unreadable evidence file; ignoring it`)
      return undefined
    }
  }

  async saveEvidence(
    issueId: string,
    snapshot: EvidenceSnapshot,
  ): Promise<void> {
    const target = this.evidenceFile(issueId)
    await mkdir(this.dir, { recursive: true })
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(snapshot), "utf8")
    await rename(tmp, target)
  }

  /**
   * Drops the carried-over evidence for a closed issue. The case file itself
   * stays: it is the issue's audit trail, and `spend.deletes` records what was
   * destroyed even after the issue closes.
   */
  async forgetEvidence(issueId: string): Promise<void> {
    await rm(this.evidenceFile(issueId), { force: true })
  }

  async save(file: CaseFile): Promise<void> {
    const target = this.file(file.issueId)
    await mkdir(this.dir, { recursive: true })
    const body = JSON.stringify(
      {
        ...file,
        updatedAt: new Date().toISOString(),
        runs: file.runs.slice(-MAX_RUNS),
      },
      null,
      2,
    )
    // Write-then-rename: a crash mid-write must not leave an unparsable file
    // that would make the issue permanently unrunnable.
    const tmp = `${target}.tmp`
    await writeFile(tmp, body, "utf8")
    await rename(tmp, target)
  }

  /** Pending revisits across all issues, for re-arming after a restart. */
  async pendingRevisits(): Promise<CaseFile[]> {
    const entries = await readdir(this.dir).catch(() => [])
    const files: CaseFile[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const file = await this.load(path.basename(entry, ".json")).catch(
        () => undefined,
      )
      if (file?.revisit) files.push(file)
    }
    return files
  }
}
