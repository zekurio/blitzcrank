import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { Data, Effect } from "effect"
import { parse } from "yaml"

import { storageIO } from "../storage.ts"
import type { StorageError } from "../storage.ts"

export interface AutomationDefinition {
  name: string
  description: string
  schedule: string
  enabled: boolean
  /** Exact mutation tools granted to this automation. Reads stay implicit. */
  mutationTools: string[]
  body: string
  filePath: string
}

type AutomationScalar = string | number | boolean | null

interface AutomationMetadata {
  name?: AutomationScalar
  description?: AutomationScalar
  schedule?: AutomationScalar
  enabled?: AutomationScalar
  mutation_tools?: AutomationScalar | AutomationScalar[]
}

const AUTOMATION_FIELDS = new Set([
  "name",
  "description",
  "schedule",
  "enabled",
  "mutation_tools",
])

/**
 * A direct mutation-tool allowlist has no second naming system to keep in sync.
 * Availability is checked when a run builds its configured service tool set.
 */
function mutationTools(
  filePath: string,
  value: AutomationMetadata["mutation_tools"],
): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`${filePath}: mutation_tools must be a list`)
  }
  const tools = value.map(String)
  for (const tool of tools) {
    if (!/^[a-z][a-z0-9_]*$/.test(tool)) {
      throw new Error(
        `${filePath}: mutation_tools contains invalid tool name ` +
          JSON.stringify(tool),
      )
    }
  }
  if (new Set(tools).size !== tools.length) {
    throw new Error(`${filePath}: mutation_tools contains a duplicate`)
  }
  return tools
}

function parseDefinition(filePath: string, raw: string): AutomationDefinition {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) throw new Error(`${filePath}: missing YAML frontmatter`)
  // SAFETY: All consumed frontmatter fields are normalized below before use.
  const meta = parse(match[1]!) as AutomationMetadata
  const body = raw.slice(match[0].length).trim()

  const unknown = Object.keys(meta).find((key) => !AUTOMATION_FIELDS.has(key))
  if (unknown)
    throw new Error(`${filePath}: unknown frontmatter field ${unknown}`)

  const name = String(meta.name ?? "")
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(
      `${filePath}: frontmatter name must be kebab-case, got "${name}"`,
    )
  }
  if (name !== path.basename(filePath, ".md")) {
    throw new Error(`${filePath}: name "${name}" must match the filename`)
  }
  const schedule = String(meta.schedule ?? "")
  if (!schedule) throw new Error(`${filePath}: schedule is required`)
  if (!body) throw new Error(`${filePath}: automation body is empty`)

  return {
    name,
    description: String(meta.description ?? ""),
    schedule,
    enabled: meta.enabled !== false,
    mutationTools: mutationTools(filePath, meta.mutation_tools),
    body,
    filePath,
  }
}

export class AutomationDefinitionError extends Data.TaggedError(
  "AutomationDefinitionError",
)<{ cause: unknown }> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

export function loadAutomationsEffect(
  dir: string,
): Effect.Effect<
  AutomationDefinition[],
  StorageError | AutomationDefinitionError
> {
  return Effect.gen(function* () {
    const entries = yield* storageIO(() =>
      readdir(dir, { withFileTypes: true }),
    ).pipe(Effect.catch(() => Effect.succeed([])))
    const definitions: AutomationDefinition[] = []
    const names = new Set<string>()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      const filePath = path.join(dir, entry.name)
      const raw = yield* storageIO(() => readFile(filePath, "utf8"))
      const definition = yield* Effect.try({
        try: () => parseDefinition(filePath, raw),
        catch: (cause) => new AutomationDefinitionError({ cause }),
      })
      if (names.has(definition.name)) {
        return yield* Effect.fail(
          new AutomationDefinitionError({
            cause: new Error(`duplicate automation name "${definition.name}"`),
          }),
        )
      }
      names.add(definition.name)
      definitions.push(definition)
    }
    return definitions
  })
}

export function loadAutomations(dir: string): Promise<AutomationDefinition[]> {
  return Effect.runPromise(loadAutomationsEffect(dir))
}
