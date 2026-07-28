import { Cron } from "croner"

import type { AutomationDefinition } from "./definitions.js"

export class AutomationScheduler {
  private readonly jobs = new Map<string, Cron>()

  constructor(private readonly enqueue: (def: AutomationDefinition) => void) {}

  start(definitions: AutomationDefinition[]): void {
    for (const def of definitions) {
      if (!def.enabled) continue
      const job = new Cron(def.schedule, { name: def.name }, () =>
        this.enqueue(def),
      )
      this.jobs.set(def.name, job)
    }
  }

  nextRun(name: string): string | undefined {
    return this.jobs.get(name)?.nextRun()?.toISOString()
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
  }
}
