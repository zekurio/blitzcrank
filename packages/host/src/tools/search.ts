import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Type } from "typebox"

import { textResult } from "./common.ts"

export const TOOL_SEARCH = "tool_search"

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
/** Further matches named, not loaded, so the next search can ask by name. */
const MAX_ALSO_MATCHED = 20
const MAX_DESCRIPTION_CHARS = 240

/**
 * Loads tools the run registered but does not offer yet. Every tool in
 * `catalog` is a Durable tool of this run from the start, with its own replay
 * policy; a search only adds names to what the next request offers.
 */
export function buildToolSearchTool(
  catalog: readonly ToolRegistration[],
): ToolRegistration {
  return defineTool({
    name: TOOL_SEARCH,
    // Changes what the conversation offers, never anything outside it.
    replay: "safe",
    description: `Load service tools so you can call them. They are not callable until loaded, and they stay loaded once they are. Pass exact tool names to load exactly those, or keywords to load the best matches by name and description. Loaded tools are callable from your next response.

Loadable tools:
${catalogLines(catalog)}`,
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description:
          "Exact tool names, or keywords such as a service and what you need, separated by spaces or commas",
      }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Most keyword matches to load (default ${DEFAULT_LIMIT}). Exact names always load`,
        }),
      ),
    }),
    execute(params) {
      const terms = queryTerms(params.query)
      const ranked = searchTools(catalog, terms)
      const named = ranked.filter((match) => match.exact)
      const loaded = (
        named.length > 0
          ? named.slice(0, MAX_LIMIT)
          : ranked.slice(0, params.limit ?? DEFAULT_LIMIT)
      ).map((match) => match.tool)
      const alsoMatched = ranked
        .map((match) => match.tool.name)
        .filter((name) => !loaded.some((tool) => tool.name === name))
      // A name-shaped term that names nothing is a typo worth reporting.
      const notFound = terms.filter(
        (term) =>
          term.includes("_") && !catalog.some((tool) => tool.name === term),
      )
      return Promise.resolve({
        ...textResult(
          {
            loaded: loaded.map((tool) => ({
              name: tool.name,
              description: tool.description.slice(0, MAX_DESCRIPTION_CHARS),
            })),
            note:
              loaded.length > 0
                ? "Loaded. Call these directly from your next response."
                : "Nothing matched. Use names or words from the list in this tool's description.",
            ...(notFound.length > 0 ? { notFound } : {}),
            ...(alsoMatched.length > 0
              ? { alsoMatched: alsoMatched.slice(0, MAX_ALSO_MATCHED) }
              : {}),
          },
          { action: TOOL_SEARCH, loaded: loaded.length },
        ),
        control: { addTools: loaded.map((tool) => tool.name) },
      })
    },
  })
}

interface Match {
  tool: ToolRegistration
  /** The query named this tool outright. */
  exact: boolean
  score: number
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((term) => term !== ""),
    ),
  ]
}

/** Best first. A term scores most as a whole name, least in a description. */
function searchTools(
  catalog: readonly ToolRegistration[],
  terms: readonly string[],
): Match[] {
  return (
    catalog
      .map((tool): Match => {
        const name = tool.name.toLowerCase()
        const words = name.split("_")
        const description = tool.description.toLowerCase()
        const score = terms.reduce((total, term) => {
          if (term === name) return total + 100
          if (words.includes(term)) return total + 10
          if (name.includes(term)) return total + 6
          if (description.includes(term)) return total + 2
          return total
        }, 0)
        return { tool, exact: terms.includes(name), score }
      })
      .filter((match) => match.score > 0)
      // Ties go to reads, which is where a diagnosis starts.
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          Number(b.tool.replay === "safe") - Number(a.tool.replay === "safe") ||
          a.tool.name.localeCompare(b.tool.name),
      )
  )
}

/** One line per name prefix, which for a server tool is its service. */
function catalogLines(catalog: readonly ToolRegistration[]): string {
  const groups = new Map<string, string[]>()
  for (const tool of catalog) {
    const group = tool.name.split("_", 1)[0] ?? tool.name
    groups.set(group, [...(groups.get(group) ?? []), tool.name])
  }
  return [...groups]
    .map(([group, names]) => `- ${group}: ${names.join(", ")}`)
    .join("\n")
}
