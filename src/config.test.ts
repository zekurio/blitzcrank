import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test, { type TestContext } from "node:test"

import { Effect } from "effect"

import { loadConfigEffect } from "./config.ts"

const seerr = { url: "http://seerr.test/", apiKey: "test-key" }
const discord = {
  id: "discord",
  type: "discord",
  token: { env: "BOT_TOKEN" },
  guildId: "100",
  reportChannelId: "200",
  inboxChannelIds: ["300", "400"],
}

async function configFile(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "blitzcrank-config-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, "config.json")
  return {
    dir,
    file,
    load: async (value: unknown, env: NodeJS.ProcessEnv = {}) => {
      await writeFile(file, JSON.stringify(value))
      return Effect.runPromise(
        loadConfigEffect({ ...env, BLITZCRANK_CONFIG: file }),
      )
    },
  }
}

test("legacy env keeps defaults and maps the Discord inbox to a gateway", async () => {
  const config = await Effect.runPromise(
    loadConfigEffect({
      SEERR_URL: seerr.url,
      SEERR_API_KEY: seerr.apiKey,
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_GUILD_ID: "100",
      DISCORD_WATCH_CHANNEL_ID: "200",
      DISCORD_INBOX_CHANNEL_ID: "300",
      DISCORD_ADMIN_ROLE_IDS: " 500,600 ",
      FIRECRAWL_API_KEY: "unused",
      SONARR_URL: "http://sonarr.test",
    }),
  )
  assert.equal(config.port, 8484)
  assert.equal(config.language, "German")
  assert.equal(config.dataDir, resolve("data"))
  assert.equal(config.automationsDir, resolve("automations"))
  assert.equal(config.seerr.url, "http://seerr.test")
  assert.equal(config.sonarr, undefined)
  assert.equal(config.media, undefined)
  assert.deepEqual(config.web, { provider: "none" })
  assert.deepEqual(config.gateways, [
    {
      ...discord,
      token: "test-token",
      inboxChannelIds: ["300"],
      model: undefined,
      triageModel: undefined,
      adminRoleIds: ["500", "600"],
    },
  ])
})

test("file config resolves paths and secrets without env setting overrides", async (t) => {
  const fixture = await configFile(t)
  await writeFile(join(fixture.dir, "seerr-key"), "from-file\n")
  const config = await fixture.load(
    {
      version: 1,
      seerr: { url: seerr.url, apiKey: { file: "seerr-key" } },
      dataDir: "state",
      automationsDir: "tasks",
      authPath: "auth.json",
      modelsPath: "models.json",
      webhookSecret: { env: "HOOK_SECRET" },
      gateways: [
        discord,
        { ...discord, id: "other-bot", token: { env: "OTHER_TOKEN" } },
      ],
    },
    {
      BOT_TOKEN: "one",
      OTHER_TOKEN: "two",
      HOOK_SECRET: "hook",
      BLITZCRANK_PORT: "9999",
      BLITZCRANK_LANGUAGE: "English",
      BLITZCRANK_WEB_PROVIDER: "firecrawl",
      FIRECRAWL_URL: "http://ignored.invalid",
      DISCORD_BOT_TOKEN: "ignored",
    },
  )
  assert.equal(config.seerr.apiKey, "from-file")
  assert.equal(config.dataDir, join(fixture.dir, "state"))
  assert.equal(config.automationsDir, join(fixture.dir, "tasks"))
  assert.equal(config.authPath, join(fixture.dir, "auth.json"))
  assert.equal(config.modelsPath, join(fixture.dir, "models.json"))
  assert.equal(config.webhookSecret, "hook")
  assert.equal(config.port, 8484)
  assert.equal(config.language, "German")
  assert.deepEqual(config.web, { provider: "none" })
  assert.equal(config.gateways.length, 2)
  assert.deepEqual(config.gateways[0]?.inboxChannelIds, ["300", "400"])
  assert.equal(config.gateways[1]?.token, "two")
})

test("file config covers service, model, media, and hosted web settings", async (t) => {
  const fixture = await configFile(t)
  const config = await fixture.load(
    {
      version: 1,
      port: 9000,
      language: "English",
      seerr,
      sonarr: seerr,
      radarr: seerr,
      sabnzbd: seerr,
      jellyfin: seerr,
      seerrBotUserId: "2",
      seerrBotUsername: "blitzcrank",
      model: "provider/issue",
      automationModel: "provider/automation",
      automationModels: { task: "provider/override" },
      media: { roots: ["/mnt/media/../media"] },
      anvil: { socket: "/run/anvil.sock" },
      web: { provider: "firecrawl", apiKey: { env: "WEB_KEY" } },
    },
    { WEB_KEY: "web-secret" },
  )
  assert.equal(config.port, 9000)
  assert.equal(config.language, "English")
  assert.equal(config.model, "provider/issue")
  assert.equal(config.automationModel, "provider/automation")
  assert.deepEqual(config.automationModels, { task: "provider/override" })
  for (const name of ["sonarr", "radarr", "sabnzbd", "jellyfin"] as const) {
    assert.deepEqual(config[name], {
      url: "http://seerr.test",
      apiKey: "test-key",
    })
  }
  assert.deepEqual(config.media, { roots: ["/mnt/media"] })
  assert.deepEqual(config.anvil, {
    socket: "/run/anvil.sock",
    command: "anvilctl",
  })
  assert.deepEqual(config.web, { provider: "firecrawl", apiKey: "web-secret" })
  assert.deepEqual(config.gateways, [])
})

test("malformed config is fatal, including unknown fields and unsafe paths", async (t) => {
  const fixture = await configFile(t)
  const invalid = [
    null,
    [],
    { seerr },
    { version: 2, seerr },
    { version: 1, seerr, typo: true },
    { version: 1, seerr: { ...seerr, typo: true } },
    { version: 1, seerr, port: 0.5 },
    { version: 1, seerr, port: 65536 },
    { version: 1, seerr: { ...seerr, url: "file:///tmp/store" } },
    { version: 1, seerr, radarr: { url: "http://radarr.test" } },
    { version: 1, seerr, model: " " },
    { version: 1, seerr, automationModels: { task: false } },
    { version: 1, seerr, media: { roots: ["/"] } },
    { version: 1, seerr, media: { roots: ["/mnt/.."] } },
    { version: 1, seerr, media: { roots: ["media"] } },
    { version: 1, seerr, media: { roots: ["/mnt/\0"] } },
    { version: 1, seerr, anvil: { socket: "relative" } },
    { version: 1, seerr, web: { provider: "firecrawl" } },
    {
      version: 1,
      seerr,
      web: { provider: "none", url: "https://example.test" },
    },
    { version: 1, seerr, gateways: [{ ...discord, id: "../escape" }] },
    { version: 1, seerr, gateways: [{ ...discord, type: "fluxer" }] },
    {
      version: 1,
      seerr,
      gateways: [{ ...discord, inboxChannelIds: ["300", "300"] }],
    },
    { version: 1, seerr, gateways: [{ ...discord, guildId: "{{guild}}" }] },
    { version: 1, seerr, gateways: [{ ...discord, reportChannelId: null }] },
    { version: 1, seerr, gateways: [{ ...discord, inboxChannelId: "300" }] },
    { version: 1, seerr, gateways: [discord, discord] },
    { version: 1, seerr, webhookSecret: { env: "KEY", file: "secret" } },
  ]
  for (const value of invalid) {
    await assert.rejects(fixture.load(value, { BOT_TOKEN: "test-token" }))
  }
})

test("multiple connections for the same Discord bot and guild are rejected", async (t) => {
  const fixture = await configFile(t)
  await assert.rejects(
    fixture.load(
      {
        version: 1,
        seerr,
        gateways: [discord, { ...discord, id: "duplicate" }],
      },
      { BOT_TOKEN: "test-token" },
    ),
    /same Discord bot\/guild twice/,
  )
  await assert.rejects(
    fixture.load(
      {
        version: 1,
        seerr,
        gateways: [
          discord,
          { ...discord, id: "prefixed", token: "Bot test-token" },
        ],
      },
      { BOT_TOKEN: "test-token" },
    ),
    /same Discord bot\/guild twice/,
  )
})

test("bad selected files never fall back to env and errors do not quote secrets", async (t) => {
  const fixture = await configFile(t)
  const env = { SEERR_URL: seerr.url, SEERR_API_KEY: seerr.apiKey }
  await assert.rejects(
    Effect.runPromise(
      loadConfigEffect({ ...env, BLITZCRANK_CONFIG: fixture.file }),
    ),
    /Cannot read/,
  )
  await writeFile(fixture.file, '{"super-secret":INVALID}')
  await assert.rejects(
    Effect.runPromise(
      loadConfigEffect({ ...env, BLITZCRANK_CONFIG: fixture.file }),
    ),
    (error: Error) => {
      assert.match(error.message, /valid JSON/)
      assert.doesNotMatch(error.message, /super-secret/)
      return true
    },
  )
  await assert.rejects(
    Effect.runPromise(loadConfigEffect({ ...env, BLITZCRANK_CONFIG: " " })),
    /must name a file/,
  )
  await assert.rejects(
    fixture.load({
      version: 1,
      seerr: { ...seerr, apiKey: { env: "MISSING" } },
    }),
    /seerr.apiKey must resolve/,
  )
  await writeFile(join(fixture.dir, "empty"), "\n")
  await assert.rejects(
    fixture.load({
      version: 1,
      seerr: { ...seerr, apiKey: { file: "empty" } },
    }),
    /seerr.apiKey must resolve/,
  )
  await assert.rejects(
    fixture.load({
      version: 1,
      seerr: { ...seerr, apiKey: { file: "missing" } },
    }),
    /Cannot read/,
  )
})

test("legacy env validation stays fail-closed for web and routing", async () => {
  const env = { SEERR_URL: seerr.url, SEERR_API_KEY: seerr.apiKey }
  for (const invalid of [
    { BLITZCRANK_PORT: "NaN" },
    { BLITZCRANK_PORT: "-1" },
    { DISCORD_BOT_TOKEN: "test-token" },
    { BLITZCRANK_AUTOMATION_MODELS: "[]" },
    { BLITZCRANK_AUTOMATION_MODELS: "{invalid}" },
    { FIRECRAWL_URL: "http://private.test" },
    { BLITZCRANK_WEB_PROVIDER: "firecrawl" },
    { BLITZCRANK_WEB_PROVIDER: "unknown" },
    { ANVIL_CONTROL_SOCKET: "" },
    { BLITZCRANK_MEDIA_ROOTS: "/" },
  ]) {
    await assert.rejects(
      Effect.runPromise(loadConfigEffect({ ...env, ...invalid })),
    )
  }
})
