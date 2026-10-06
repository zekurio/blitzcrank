import { Effect } from "effect"

import { JobStore } from "../jobs.ts"
import type { Job } from "../jobs.ts"
import type { SerialQueue } from "../queue.ts"
import type { AutomationDefinition } from "./definitions.ts"
import type { AutomationReport } from "./runner.ts"

export interface AutomationInfo {
  name: string
  description: string
  schedule: string
  enabled: boolean
  mutationTools: string[]
  nextRun: string | undefined
}

/** `busy` means a run of that automation is already queued or in flight. */
export type TriggerResult = "queued" | "busy" | "unknown"

export interface DispatcherDeps {
  /** Automations loaded at boot; nothing else can ever be dispatched. */
  definitions: AutomationDefinition[]
  queue: SerialQueue
  jobs?: JobStore
  run: (
    def: AutomationDefinition,
    runId: string,
  ) => Effect.Effect<AutomationReport, unknown>
  /** Report hand-off (Discord today). A broken sink must not leak a slot. */
  publish: (report: AutomationReport) => Effect.Effect<void, unknown>
  /** Next cron occurrence, for `list()`; owned by the scheduler. */
  nextRun: (name: string) => string | undefined
}

/**
 * Owns "one run per automation at a time".
 *
 * The cron scheduler, `POST /automations/:name/run` and the Discord
 * `/automation run` command all dispatch through here, so a tick or a trigger
 * that arrives while the same automation is queued or in flight is refused
 * rather than stacked. The slot is held from the moment the run is queued
 * until the run (and its report) settle, and released in a `finally` so a
 * throwing run cannot wedge the automation forever.
 */
export class AutomationDispatcher {
  private readonly inFlight = new Set<string>()
  private readonly jobs: JobStore

  constructor(private readonly deps: DispatcherDeps) {
    this.jobs = deps.jobs ?? new JobStore()
  }

  /** Cron entry point: dispatch an already-loaded definition. */
  dispatch(def: AutomationDefinition): TriggerResult {
    if (
      this.deps.queue.closed ||
      this.inFlight.has(def.name) ||
      this.jobs
        .pending("automation")
        .some((job) => job.busyKey === `automation:${def.name}`)
    ) {
      console.warn(
        `[automation:${def.name}] already queued or running; skipped`,
      )
      return "busy"
    }
    const loaded = this.deps.definitions.find(
      (candidate) => candidate.name === def.name,
    )
    if (!loaded) return "unknown"
    const job = this.jobs.create(
      "automation",
      { name: loaded.name, definition: loaded },
      {
        busyKey: `automation:${loaded.name}`,
      },
    )
    this.schedule(job, job.payload.definition)
    return "queued"
  }

  /** Call after report delivery is ready and before accepting cron ticks. */
  restore(): void {
    if (this.deps.queue.closed) throw new Error("queue is closed")
    for (const job of this.jobs.pending("automation")) {
      const payload = job.payload as {
        name?: unknown
        definition?: Partial<AutomationDefinition>
      } | null
      const def = this.deps.definitions.find(
        (candidate) => candidate.name === payload?.name,
      )
      if (
        !def ||
        definitionPolicy(def) !== definitionPolicy(payload?.definition)
      ) {
        this.jobs.markFailed(job.id, "Automation definition removed or changed")
        console.error(
          `[automation:${job.id}] definition removed or changed; not resumed`,
        )
        continue
      }
      if (!this.inFlight.has(def.name)) this.schedule(job, def)
    }
  }

  private schedule(job: Job, def: AutomationDefinition): void {
    this.inFlight.add(def.name)
    this.jobs.enqueue(this.deps.queue, job, () =>
      Effect.suspend(() => this.deps.run(def, job.id)).pipe(
        Effect.flatMap((report) =>
          this.jobs.actionEffect(
            job.id,
            "publish",
            Effect.suspend(() => this.deps.publish(report)),
          ),
        ),
        Effect.ensuring(Effect.sync(() => this.inFlight.delete(def.name))),
      ),
    )
  }

  /** HTTP and Discord entry point: dispatch by name. */
  trigger(name: string): TriggerResult {
    const def = this.deps.definitions.find((d) => d.name === name)
    if (!def) return "unknown"
    return this.dispatch(def)
  }

  list(): AutomationInfo[] {
    return this.deps.definitions.map((def) => ({
      name: def.name,
      description: def.description,
      schedule: def.schedule,
      enabled: def.enabled,
      mutationTools: def.mutationTools,
      nextRun: this.deps.nextRun(def.name),
    }))
  }

  /** Automations queued or running right now, for shutdown logging. */
  get active(): string[] {
    return [...this.inFlight]
  }
}

/** Source paths change on every Nix package build; they are not run policy. */
function definitionPolicy(
  definition: Partial<AutomationDefinition> | undefined,
): string {
  return JSON.stringify([
    definition?.name,
    definition?.description,
    definition?.schedule,
    definition?.enabled,
    definition?.mutationTools,
    definition?.body,
  ])
}
