import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"

import { Effect } from "effect"

import { loadConfigEffect } from "./config.ts"

const seerr = { url: "http://seerr.test/", apiKey: "test-key" }
const guild = {
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

test("BLITZCRANK_CONFIG is required and legacy env settings are ignored", async () => {
  const legacy = {
    SEERR_URL: seerr.url,
    SEERR_API_KEY: seerr.apiKey,
    DISCORD_BOT_TOKEN: "token",
  }
  await assert.rejects(
    Effect.runPromise(loadConfigEffect(legacy)),
    /BLITZCRANK_CONFIG must name a file/,
  )
  await assert.rejects(
    Effect.runPromise(loadConfigEffect({ ...legacy, BLITZCRANK_CONFIG: " " })),
    /BLITZCRANK_CONFIG must name a file/,
  )
})

test("file config resolves paths, secrets, and defaults", async (t) => {
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
    },
    {
      HOOK_SECRET: "hook",
      BLITZCRANK_PORT: "9999",
      SEERR_API_KEY: "ignored",
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
  assert.deepEqual(config.gateways, { discord: undefined })
})

test("one Discord token configures multiple guilds", async (t) => {
  const fixture = await configFile(t)
  const config = await fixture.load(
    {
      version: 1,
      seerr,
      gateways: {
        discord: {
          token: { env: "BOT_TOKEN" },
          guilds: [
            guild,
            {
              guildId: "101",
              reportChannelId: "201",
              model: "provider/chat",
              triageModel: "provider/triage",
              adminRoleIds: ["500"],
            },
          ],
        },
      },
    },
    { BOT_TOKEN: "one-token" },
  )
  assert.deepEqual(config.gateways.discord, {
    token: "one-token",
    guilds: [
      {
        ...guild,
        model: undefined,
        triageModel: undefined,
        adminRoleIds: [],
      },
      {
        guildId: "101",
        reportChannelId: "201",
        inboxChannelIds: [],
        model: "provider/chat",
        triageModel: "provider/triage",
        adminRoleIds: ["500"],
      },
    ],
  })
})

test("Discord rejects old shapes, empty guilds, and duplicate IDs", async (t) => {
  const fixture = await configFile(t)
  const invalid = [
    { gateways: [] },
    {
      gateways: {
        discord: {
          id: "discord",
          type: "discord",
          token: "token",
          guildId: "100",
          reportChannelId: "200",
        },
      },
    },
    { gateways: { discord: { token: "token", guilds: [] } } },
    {
      gateways: {
        discord: { token: "token", guilds: [guild, guild] },
      },
    },
    {
      gateways: {
        discord: {
          token: "token",
          guilds: [{ ...guild, inboxChannelIds: ["300", "300"] }],
        },
      },
    },
    {
      gateways: {
        discord: {
          token: "token",
          guilds: [{ ...guild, adminRoleIds: ["500", "500"] }],
        },
      },
    },
  ]
  for (const value of invalid) {
    await assert.rejects(fixture.load({ version: 1, seerr, ...value }))
  }
})

test("generic fields and strict validation remain supported", async (t) => {
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
  assert.equal(config.model, "provider/issue")
  assert.deepEqual(config.automationModels, { task: "provider/override" })
  assert.deepEqual(config.media, { roots: ["/mnt/media"] })
  assert.deepEqual(config.anvil, {
    socket: "/run/anvil.sock",
    command: "anvilctl",
  })
  assert.deepEqual(config.web, { provider: "firecrawl", apiKey: "web-secret" })
})

test("malformed generic configuration is rejected", async (t) => {
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
  ]
  for (const value of invalid) {
    await assert.rejects(fixture.load(value))
  }
})

test("selected files and secret references fail closed", async (t) => {
  const fixture = await configFile(t)
  await assert.rejects(
    Effect.runPromise(
      loadConfigEffect({
        BLITZCRANK_CONFIG: fixture.file,
        SEERR_URL: seerr.url,
        SEERR_API_KEY: seerr.apiKey,
      }),
    ),
    /Cannot read/,
  )
  await writeFile(fixture.file, '{"super-secret":INVALID}')
  await assert.rejects(
    Effect.runPromise(loadConfigEffect({ BLITZCRANK_CONFIG: fixture.file })),
    (error: Error) => {
      assert.match(error.message, /valid JSON/)
      assert.doesNotMatch(error.message, /super-secret/)
      return true
    },
  )
  for (const apiKey of [
    { env: "MISSING" },
    { env: "KEY", file: "secret" },
    { file: "missing" },
  ]) {
    await assert.rejects(
      fixture.load({ version: 1, seerr: { ...seerr, apiKey } }),
    )
  }
  await assert.rejects(
    fixture.load(
      {
        version: 1,
        seerr: { ...seerr, apiKey: { env: "NUL_SECRET" } },
      },
      { NUL_SECRET: "before\0after" },
    ),
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
})
