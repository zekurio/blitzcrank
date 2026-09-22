import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"

import { Effect } from "effect"
import { Check, Errors } from "typebox/value"

import { ConfigSchema, type FileConfig, type Secret } from "./config/schema.ts"

export interface ServiceConfig {
  url: string
  apiKey: string
}

export interface AnvilConfig {
  command: string
  socket: string
}

export interface DiscordGuildConfig {
  /** Guild whose commands are registered; interactions elsewhere are refused. */
  guildId: string
  /** Text channel the per-automation report threads live in. */
  reportChannelId: string
  /** Text channels whose messages are triaged into private conversations. */
  inboxChannelIds: string[]
  /** Model for accepted private conversations. */
  model: string | undefined
  /** Cheap model that decides whether an inbox message needs a response. */
  triageModel: string | undefined
  /**
   * Roles allowed to trigger automations, on top of guild administrators.
   * Empty means administrators only.
   */
  adminRoleIds: string[]
}

export interface DiscordConfig {
  token: string
  guilds: DiscordGuildConfig[]
}

export interface GatewayConfig {
  discord: DiscordConfig | undefined
}

export interface MediaConfig {
  /** Absolute directory roots media_probe may read; nothing else is readable. */
  roots: string[]
}

export interface AutomationModelMap {
  [name: string]: string
}

export type WebConfig =
  | { provider: "firecrawl"; apiKey: string }
  | { provider: "none" }

export interface Config {
  port: number
  /** Persistent state (session transcripts) lives here. */
  dataDir: string
  /** Directory containing automation definition .md files. */
  automationsDir: string
  /** Shared secret checked against the Authorization header of incoming webhooks. */
  webhookSecret: string | undefined
  /** Model for issue runs, e.g. "anthropic/claude-sonnet-4-5". */
  model: string | undefined
  /** Default model for automations; absent inherits `model`. */
  automationModel: string | undefined
  /** Per-automation model overrides, keyed by automation name. */
  automationModels: AutomationModelMap
  /**
   * pi auth.json holding API keys and OAuth credentials (e.g. openai-codex).
   * Must be writable: OAuth tokens auto-refresh and are persisted back.
   * Defaults to pi's own ~/.pi/agent/auth.json when unset.
   */
  authPath: string | undefined
  /** pi models.json declaring custom providers. */
  modelsPath: string | undefined
  /** Language for public comments (default German, matching the deployment). */
  language: string
  /** External web search/extract for issue and Discord conversation runs. */
  web: WebConfig
  /** Seerr user id sent as X-Api-User so bot comments are attributed correctly. */
  seerrBotUserId: string | undefined
  /** Display name of the bot's Seerr user; its own comment webhooks are ignored. */
  seerrBotUsername: string | undefined
  seerr: ServiceConfig
  sonarr: ServiceConfig | undefined
  radarr: ServiceConfig | undefined
  sabnzbd: ServiceConfig | undefined
  jellyfin: ServiceConfig | undefined
  /** Enables Anvil correlation and retry tools when its control socket is set. */
  anvil: AnvilConfig | undefined
  /** Enables media reads; frame extraction also requires model image support. */
  media: MediaConfig | undefined
  /** Host-side messaging gateway configuration. */
  gateways: GatewayConfig
}

export function loadConfigEffect(
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<Config, Error> {
  return Effect.gen(function* () {
    const selected = env.BLITZCRANK_CONFIG
    if (selected === undefined || !selected.trim()) {
      return yield* Effect.fail(new Error("BLITZCRANK_CONFIG must name a file"))
    }
    const file = resolve(selected)
    const baseDir = dirname(file)
    const raw = yield* readTextEffect(file).pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: (): unknown => JSON.parse(text),
          catch: () => new Error("BLITZCRANK_CONFIG must contain valid JSON"),
        }),
      ),
    )
    const input = yield* Effect.try({
      try: () => validateConfig(raw),
      catch: configError,
    })
    const secret = (value: Secret, name: string) =>
      resolveSecretEffect(value, name, env, baseDir)
    const service = (value: FileConfig["seerr"], name: string) =>
      secret(value.apiKey, `${name}.apiKey`).pipe(
        Effect.map((apiKey) => ({
          url: value.url.replace(/\/+$/, ""),
          apiKey,
        })),
      )
    const discord =
      input.gateways?.discord === undefined
        ? undefined
        : {
            token: yield* secret(
              input.gateways.discord.token,
              "gateways.discord.token",
            ),
            guilds: input.gateways.discord.guilds.map(
              (guild): DiscordGuildConfig => ({
                ...guild,
                inboxChannelIds: guild.inboxChannelIds ?? [],
                adminRoleIds: guild.adminRoleIds ?? [],
                model: guild.model,
                triageModel: guild.triageModel,
              }),
            ),
          }
    return {
      port: input.port ?? 8484,
      dataDir: resolve(baseDir, input.dataDir ?? "data"),
      automationsDir: resolve(baseDir, input.automationsDir ?? "automations"),
      webhookSecret:
        input.webhookSecret === undefined
          ? undefined
          : yield* secret(input.webhookSecret, "webhookSecret"),
      model: input.model,
      automationModel: input.automationModel,
      automationModels: input.automationModels ?? {},
      authPath:
        input.authPath === undefined
          ? undefined
          : resolve(baseDir, input.authPath),
      modelsPath:
        input.modelsPath === undefined
          ? undefined
          : resolve(baseDir, input.modelsPath),
      language: input.language ?? "German",
      web:
        input.web?.provider === "firecrawl"
          ? {
              provider: "firecrawl",
              apiKey: yield* secret(input.web.apiKey, "web.apiKey"),
            }
          : { provider: "none" },
      seerrBotUserId: input.seerrBotUserId,
      seerrBotUsername: input.seerrBotUsername,
      seerr: yield* service(input.seerr, "seerr"),
      sonarr:
        input.sonarr === undefined
          ? undefined
          : yield* service(input.sonarr, "sonarr"),
      radarr:
        input.radarr === undefined
          ? undefined
          : yield* service(input.radarr, "radarr"),
      sabnzbd:
        input.sabnzbd === undefined
          ? undefined
          : yield* service(input.sabnzbd, "sabnzbd"),
      jellyfin:
        input.jellyfin === undefined
          ? undefined
          : yield* service(input.jellyfin, "jellyfin"),
      anvil:
        input.anvil === undefined
          ? undefined
          : {
              command: input.anvil.command ?? "anvilctl",
              socket: input.anvil.socket,
            },
      media: input.media?.roots.length
        ? { roots: input.media.roots.map((root) => resolve(root)) }
        : undefined,
      gateways: { discord },
    }
  })
}

function validateConfig(value: unknown): FileConfig {
  if (!Check(ConfigSchema, value)) {
    // TypeBox messages describe constraints, never rejected secret values.
    const errors = Errors(ConfigSchema, value)
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ")
    throw new Error(`Invalid configuration: ${errors}`)
  }
  const guildIds =
    value.gateways?.discord?.guilds.map((guild) => guild.guildId) ?? []
  if (new Set(guildIds).size !== guildIds.length) {
    throw new Error("gateways.discord.guilds must have unique guildIds")
  }
  for (const name of [
    "seerr",
    "sonarr",
    "radarr",
    "sabnzbd",
    "jellyfin",
  ] as const) {
    const service = value[name]
    if (service === undefined) continue
    const url = URL.parse(service.url)
    if (!url || !["http:", "https:"].includes(url.protocol)) {
      throw new Error(`${name}.url must be an HTTP(S) URL`)
    }
  }
  if (value.anvil && !isAbsolute(value.anvil.socket)) {
    throw new Error("anvil.socket must be an absolute path")
  }
  for (const root of value.media?.roots ?? []) {
    if (!isAbsolute(root) || resolve(root) === "/") {
      throw new Error("media.roots must name absolute directories below /")
    }
  }
  return value
}

function readTextEffect(file: string) {
  return Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: () => new Error(`Cannot read configuration file ${file}`),
  })
}

function configError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Invalid configuration")
}

function resolveSecretEffect(
  value: Secret,
  name: string,
  env: NodeJS.ProcessEnv,
  baseDir: string,
): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    const resolved =
      typeof value === "string"
        ? value
        : "env" in value
          ? env[value.env]
          : (yield* readTextEffect(resolve(baseDir, value.file))).trimEnd()
    if (resolved === undefined || !resolved.trim() || resolved.includes("\0")) {
      return yield* Effect.fail(
        new Error(`${name} must resolve to a non-empty secret`),
      )
    }
    return resolved
  })
}
