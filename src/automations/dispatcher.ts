import type { SerialQueue } from "../queue.js"
import type { AutomationDefinition } from "./definitions.js"
import type { AutomationReport } from "./runner.js"

export interface AutomationInfo {
  name: string
  description: string
  schedule: string
  enabled: boolean
  capabilities: string[]
  nextRun: string | undefined
}

/** `busy` means a run of that automation is already queued or in flight. */
export type TriggerResult = "queued" | "busy" | "unknown"

export interface DispatcherDeps {
  /** Automations loaded at boot; nothing else can ever be dispatched. */
  definitions: AutomationDefinition[]
  queue: SerialQueue
  run: (def: AutomationDefinition) => Promise<AutomationReport>
  /** Report hand-off (Discord today). A broken sink must not leak a slot. */
  publish: (report: AutomationReport) => Promise<void>
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

  constructor(private readonly deps: DispatcherDeps) {}

  /** Cron entry point: dispatch an already-loaded definition. */
  dispatch(def: AutomationDefinition): TriggerResult {
    if (this.inFlight.has(def.name)) {
      console.warn(
        `[automation:${def.name}] already queued or running; skipped`,
      )
      return "busy"
    }
    this.inFlight.add(def.name)
    this.deps.queue.enqueue(async () => {
      try {
        const report = await this.deps.run(def)
        await this.deps.publish(report)
      } finally {
        this.inFlight.delete(def.name)
      }
    })
    return "queued"
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
      capabilities: def.capabilities,
      nextRun: this.deps.nextRun(def.name),
    }))
  }

  /** Automations queued or running right now, for shutdown logging. */
  get active(): string[] {
    return [...this.inFlight]
  }
}
