/**
 * The host's own lines on a thread: the queue notice, the working line a run
 * shows until its reply replaces it, the step lines that rewrite it while the
 * run calls tools, and the line a gateway posts when it turns a request away.
 * The model writes none of them.
 */

import type { ToolStep } from "./session.ts"

export function queuedMessage(language: string, runsAhead: number): string {
  if (isGerman(language)) {
    const ahead =
      runsAhead === 1
        ? "Vor dir ist noch eine Aufgabe."
        : `Vor dir sind noch ${runsAhead} Aufgaben.`
    return `⏳ ${pick(QUEUED_DE)} ${ahead}`
  }
  const ahead =
    runsAhead === 1
      ? "One task is ahead of you."
      : `${runsAhead} tasks are ahead of you.`
  return `⏳ ${pick(QUEUED_EN)} ${ahead}`
}

export function workingMessage(language: string): string {
  return isGerman(language)
    ? `⚙️ Blitzcrank ${pick(WORKING_DE)} …`
    : `⚙️ Blitzcrank is ${pick(WORKING_EN)}…`
}

/**
 * The status line for a tool call a run starts, or undefined for a call not
 * worth one. Only the tool's name and whether it may write choose the line,
 * so nothing the model put into the call reaches the thread.
 */
export function stepMessage(
  language: string,
  step: ToolStep,
): string | undefined {
  const german = isGerman(language)
  const fixed = (german ? STEPS_DE : STEPS_EN).get(step.tool)
  if (fixed !== undefined) return fixed
  const service = SERVICES.get(step.tool.split("_", 1)[0] ?? "")
  if (service === undefined) return undefined
  if (german)
    return step.write
      ? `✏️ Blitzcrank ändert etwas in ${service} …`
      : `🔍 Blitzcrank schaut in ${service} nach …`
  return step.write
    ? `✏️ Blitzcrank is changing something in ${service}…`
    : `🔍 Blitzcrank is checking ${service}…`
}

/** For a request outside the homelab. It starts no run. */
export function outOfScopeMessage(language: string): string {
  return isGerman(language)
    ? "🤖 Blitzcrank hilft nur beim Medienserver: Anfragen, Downloads, Wiedergabe, Untertitel und so weiter."
    : "🤖 Blitzcrank only helps with the media server: requests, downloads, playback, subtitles, and the like."
}

function isGerman(language: string): boolean {
  return /^(de|deutsch|german)(-|_|\b)/i.test(language.trim())
}

type Lines = readonly [string, ...string[]]

// The journal never posts a recorded notice twice, so a pick need not be
// reproducible.
function pick(lines: Lines): string {
  return lines[Math.floor(Math.random() * lines.length)] ?? lines[0]
}

// Each line says that work is under way and nothing about what the work is: a
// run may answer a new report or a one-word comment. The German leans
// Austrian and Bavarian, like its readers.
const WORKING_DE: Lines = [
  "tüftelt",
  "grübelt",
  "knobelt",
  "brütet",
  "sinniert",
  "kombiniert",
  "zerbricht sich den Kopf",
  "heckt etwas aus",
  "stöbert",
  "kramt",
  "stierlt herum",
  "schnüffelt herum",
  "ermittelt",
  "schaut nach",
  "geht der Sache nach",
  "nimmt das unter die Lupe",
  "wühlt sich durch",
  "fieselt das auseinander",
  "werkelt",
  "schraubt",
  "bastelt",
  "hackelt",
  "rackert",
  "fuhrwerkt herum",
  "tut herum",
  "wurschtelt sich durch",
  "taucht an",
  "packt's an",
  "rattert",
  "spult zurück",
  "sichtet das Material",
  "steigt ins Archiv hinab",
  "wirft den Projektor an",
  "durchforstet die Mediathek",
]

const WORKING_EN: Lines = [
  "tinkering",
  "pondering",
  "puzzling it out",
  "brooding",
  "musing",
  "deducing",
  "racking its brain",
  "hatching a plan",
  "rummaging",
  "digging around",
  "snooping around",
  "investigating",
  "having a look",
  "following the trail",
  "taking a closer look",
  "burrowing through",
  "untangling this",
  "pottering",
  "wrenching",
  "toiling",
  "muddling through",
  "getting stuck in",
  "rattling",
  "rewinding",
  "reviewing the footage",
  "descending into the archive",
  "firing up the projector",
  "combing the library",
]

const QUEUED_DE: Lines = [
  "Blitzcrank hat gerade alle Hände voll.",
  "Blitzcrank steckt noch in einer anderen Sache.",
  "Blitzcrank hackelt noch woanders.",
  "Blitzcrank ist gleich bei dir.",
  "Ein bisserl Geduld, Blitzcrank ist gleich da.",
]

const QUEUED_EN: Lines = [
  "Blitzcrank has its hands full right now.",
  "Blitzcrank is still stuck in another job.",
  "Blitzcrank is still busy elsewhere.",
  "Blitzcrank will be with you shortly.",
]

// A server tool's name starts with the service it reaches.
const SERVICES = new Map([
  ["seerr", "Seerr"],
  ["sonarr", "Sonarr"],
  ["radarr", "Radarr"],
  ["sabnzbd", "SABnzbd"],
  ["jellyfin", "Jellyfin"],
])

// Tools that reach no service, by name. A renamed tool loses its line until
// it is renamed here too. `tool_search` only loads tools and has none.
const STEPS_DE = new Map([
  ["media_probe", "🎞️ Blitzcrank untersucht die Datei …"],
  ["media_frames", "🎞️ Blitzcrank sieht sich Standbilder an …"],
  ["web_search", "🌐 Blitzcrank sucht im Web …"],
  ["web_extract", "🌐 Blitzcrank liest eine Webseite …"],
  ["thread_history_search", "📖 Blitzcrank durchsucht frühere Gespräche …"],
  ["read", "📖 Blitzcrank schlägt im Handbuch nach …"],
])

const STEPS_EN = new Map([
  ["media_probe", "🎞️ Blitzcrank is inspecting the file…"],
  ["media_frames", "🎞️ Blitzcrank is looking at still frames…"],
  ["web_search", "🌐 Blitzcrank is searching the web…"],
  ["web_extract", "🌐 Blitzcrank is reading a web page…"],
  [
    "thread_history_search",
    "📖 Blitzcrank is searching earlier conversations…",
  ],
  ["read", "📖 Blitzcrank is checking its handbook…"],
])
