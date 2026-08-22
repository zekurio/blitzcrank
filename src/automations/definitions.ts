import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { parse } from "yaml"

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

export async function loadAutomations(
  dir: string,
): Promise<AutomationDefinition[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const definitions: AutomationDefinition[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const filePath = path.join(dir, entry.name)
    definitions.push(
      parseDefinition(filePath, await readFile(filePath, "utf8")),
    )
  }
  const names = new Set<string>()
  for (const def of definitions) {
    if (names.has(def.name))
      throw new Error(`duplicate automation name "${def.name}"`)
    names.add(def.name)
  }
  return definitions
}
