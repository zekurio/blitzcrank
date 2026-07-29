import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Per-issue case file: the agent's memory between runs.
 *
 * Without it every trigger starts blank, repeats the same fifteen discovery
 * reads, and then pages through its own raw session transcripts to recover
 * what it already knew — the single most expensive run of the incident that
 * motivated this file produced no mutations and no new information.
 *
 * Two writers, deliberately separated:
 *  - the agent writes `summary` through the `update_case_file` tool (what is
 *    established, what is ruled out, what is still open),
 *  - the host writes everything factual: run records, cumulative spend, the
 *    pending revisit and its chain length. The agent cannot edit those, so it
 *    cannot talk itself past a budget or a revisit cap.
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
  tokens: number
  cost: number
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
  runs: CaseRun[]
  spend: { runs: number; tokens: number; cost: number }
  revisit: PendingRevisit | undefined
  /** Set once the budget message was posted, so it is posted only once. */
  budgetNotified: boolean
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
    runs: [],
    spend: { runs: 0, tokens: 0, cost: 0 },
    revisit: undefined,
    budgetNotified: false,
  }
}

/** Model-supplied text is capped hard: this file is re-read every run. */
export function clampEntries(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().replace(/\s+/g, " ").slice(0, MAX_ENTRY_CHARS))
    .filter((value) => value.length > 0)
    .slice(0, MAX_ENTRIES)
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

  async load(issueId: string): Promise<CaseFile> {
    const raw = await readFile(this.file(issueId), "utf8").catch(
      () => undefined,
    )
    if (raw === undefined) return emptyCase(issueId)
    const parsed = JSON.parse(raw) as Partial<CaseFile>
    const empty = emptyCase(issueId)
    return {
      ...empty,
      ...parsed,
      issueId,
      summary: { ...empty.summary, ...parsed.summary },
      spend: { ...empty.spend, ...parsed.spend },
      runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-MAX_RUNS) : [],
    }
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
