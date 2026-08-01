/**
 * Checks that the documented tool surface matches the real one.
 *
 * Prompts and skills name tools in prose, so nothing in the type system stops
 * them drifting apart from the registry — and they did, twice: a description
 * claiming the Anvil surface was read-only after a retry tool landed, and one
 * denying that same tool while it sat beside it. The model reads those strings
 * as the authority on what it can do, which makes the drift a behaviour bug
 * rather than a documentation one.
 *
 * Two directions, both cheap:
 *  - every registered tool is described in at least one skill or in the system
 *    prompt, so a new tool cannot ship undocumented,
 *  - every tool-shaped name in the skills or the prompt is a registered tool,
 *    so a rename or removal cannot leave instructions pointing at nothing.
 */
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { buildSystemPrompt } from "../src/agent/prompt.js"
import { emptyCase } from "../src/casefile.js"
import type { Config } from "../src/config.js"
import { RunContext } from "../src/tools/context.js"
import { buildIssueTools } from "../src/tools/index.js"

/** Every optional service configured, so the full tool surface is registered. */
const service = { url: "http://service.invalid", apiKey: "key" }
const config: Config = {
  port: 8484,
  dataDir: "data",
  automationsDir: "automations",
  webhookSecret: undefined,
  model: undefined,
  automationModel: undefined,
  authPath: undefined,
  modelsPath: undefined,
  firecrawl: { apiKey: "key", apiUrl: "https://api.firecrawl.dev" },
  language: "German",
  seerrBotUserId: undefined,
  seerrBotUsername: undefined,
  seerr: service,
  sonarr: service,
  radarr: service,
  sabnzbd: service,
  jellyfin: service,
  anvil: { command: "anvilctl", socket: "/run/anvil/anvild.sock" },
  media: { roots: ["/mnt/media"] },
}

const tools = buildIssueTools({
  config,
  ctx: new RunContext(),
  seerr: {} as never,
  issueId: "0",
  anchor: "[blitzcrank]",
  sessionFileRef: { current: undefined },
  mediaScope: undefined,
  status: { id: undefined },
  casefile: emptyCase("0"),
})
const registered = new Set(tools.map((tool) => tool.name))

const skillsDir = path.join(import.meta.dirname, "..", "skills")
const docs: Array<{ where: string; text: string }> = [
  {
    where: "src/agent/prompt.ts",
    text: buildSystemPrompt(config, [...registered]),
  },
]
for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const file = path.join(skillsDir, entry.name, "SKILL.md")
  docs.push({
    where: `skills/${entry.name}/SKILL.md`,
    text: await readFile(file, "utf8"),
  })
}

// Only names carrying a tool prefix: `missing_languages` and `path_outside_libraries`
// are payload fields, not tools, and must not be mistaken for them.
const TOOL_SHAPED =
  /\b(?:seerr|sonarr|radarr|jellyfin|sabnzbd|anvil|media|web|thread|report|update)_[a-z][a-z_]*\b/g

const problems: string[] = []

for (const tool of registered) {
  const seen = docs.some((doc) => doc.text.includes(tool))
  if (!seen) {
    problems.push(
      `${tool} is registered but described in no skill and not in the system prompt`,
    )
  }
}

for (const doc of docs) {
  for (const name of new Set(doc.text.match(TOOL_SHAPED) ?? [])) {
    if (registered.has(name)) continue
    problems.push(`${doc.where} names ${name}, which is not a registered tool`)
  }
}

if (problems.length > 0) {
  console.error(
    `tool surface and its documentation disagree:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
  )
  process.exit(1)
}
console.log(`tool surface matches its documentation (${registered.size} tools)`)
