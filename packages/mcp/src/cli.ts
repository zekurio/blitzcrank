import { readFile } from "node:fs/promises"

import { Cause, Effect } from "effect"

import { loadConfig, type Config } from "./config.ts"
import { buildMediaFramesTool } from "./media/frames.ts"
import { buildMediaProbeTool } from "./media/probe.ts"
import { createHttpServer } from "./server.ts"
import { buildJellyfinTools } from "./services/jellyfin.ts"
import { buildRadarrTools } from "./services/radarr.ts"
import { buildSabnzbdTools } from "./services/sabnzbd.ts"
import { buildSeerrTools } from "./services/seerr.ts"
import { buildSonarrTools } from "./services/sonarr.ts"
import type { ServerTool } from "./tools.ts"

/** Tools for the configured services only; the rest are never declared. */
function buildTools(config: Config): ServerTool[] {
  return [
    ...(config.seerr ? buildSeerrTools(config.seerr) : []),
    ...(config.sonarr ? buildSonarrTools(config.sonarr) : []),
    ...(config.radarr ? buildRadarrTools(config.radarr) : []),
    ...(config.sabnzbd ? buildSabnzbdTools(config.sabnzbd) : []),
    ...(config.jellyfin ? buildJellyfinTools(config.jellyfin) : []),
    ...(config.mediaRoots.length > 0
      ? [
          buildMediaProbeTool(config.mediaRoots),
          buildMediaFramesTool(config.mediaRoots),
        ]
      : []),
  ]
}

const main = Effect.gen(function* () {
  const config = loadConfig()
  // The package root holds package.json next to dist/ and src/ alike.
  const manifest = JSON.parse(
    yield* Effect.promise(() =>
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ),
  ) as { version: string }
  const tools = buildTools(config)
  const server = createHttpServer({
    token: config.token,
    version: manifest.version,
    tools,
  })
  yield* Effect.callback<void, Error>((resume) => {
    server.once("error", (error) => resume(Effect.fail(error)))
    server.listen(config.port, config.host, () => resume(Effect.void))
  })
  const address = server.address()
  console.log(
    `[mcp] listening on ${typeof address === "string" ? address : `${address?.address}:${address?.port}`} with ${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}`,
  )
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(`[mcp] ${signal}: closing the listener`)
      // Stops accepting. A call still in flight finishes, a write included;
      // the process ends once nothing is left running.
      server.close()
      server.closeIdleConnections()
    })
  }
})

Effect.runFork(
  main.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        const error = Cause.squash(cause)
        console.error(
          "fatal:",
          error instanceof Error ? error.message : String(error),
        )
        process.exit(1)
      }),
    ),
  ),
)
