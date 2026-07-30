import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { loadConfig } from "./config.js"

/**
 * Keys these tests set or must neutralize: an ambient BLITZCRANK_* value from
 * the developer's shell would otherwise decide the outcome.
 */
const MANAGED = [
  "SEERR_URL",
  "SEERR_API_KEY",
  "BLITZCRANK_PORT",
  "BLITZCRANK_MEDIA_ROOTS",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_WATCH_CHANNEL_ID",
  "DISCORD_ADMIN_ROLE_IDS",
] as const

const saved = MANAGED.map((key) => [key, process.env[key]] as const)

/** Clears every managed key, then applies the Seerr credentials plus extras. */
function setEnv(extra: Record<string, string>): void {
  for (const key of MANAGED) delete process.env[key]
  process.env.SEERR_URL = "http://seerr.test:5055"
  process.env.SEERR_API_KEY = "seerr-key"
  Object.assign(process.env, extra)
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
})

test("requires Seerr credentials", () => {
  setEnv({})
  delete process.env.SEERR_API_KEY
  assert.throws(loadConfig, /SEERR_URL and SEERR_API_KEY are required/)
})

test("leaves discord unconfigured without a bot token", () => {
  setEnv({
    DISCORD_GUILD_ID: "guild-1",
    DISCORD_WATCH_CHANNEL_ID: "channel-1",
  })
  assert.equal(loadConfig().discord, undefined)
})

test("refuses a bot token without guild and channel", () => {
  setEnv({ DISCORD_BOT_TOKEN: "token-1" })
  assert.throws(
    loadConfig,
    /DISCORD_BOT_TOKEN requires DISCORD_GUILD_ID and DISCORD_WATCH_CHANNEL_ID/,
  )
  setEnv({ DISCORD_BOT_TOKEN: "token-1", DISCORD_GUILD_ID: "guild-1" })
  assert.throws(loadConfig, /DISCORD_WATCH_CHANNEL_ID/)
  setEnv({ DISCORD_BOT_TOKEN: "token-1", DISCORD_WATCH_CHANNEL_ID: "chan-1" })
  assert.throws(loadConfig, /DISCORD_GUILD_ID/)
})

test("builds a discord config from token, guild and channel", () => {
  setEnv({
    DISCORD_BOT_TOKEN: "token-1",
    DISCORD_GUILD_ID: "guild-1",
    DISCORD_WATCH_CHANNEL_ID: "channel-1",
  })
  assert.deepEqual(loadConfig().discord, {
    token: "token-1",
    guildId: "guild-1",
    watchChannelId: "channel-1",
    adminRoleIds: [],
  })
})

test("splits admin role ids on commas, trimming empty entries", () => {
  setEnv({
    DISCORD_BOT_TOKEN: "token-1",
    DISCORD_GUILD_ID: "guild-1",
    DISCORD_WATCH_CHANNEL_ID: "channel-1",
    DISCORD_ADMIN_ROLE_IDS: " 111 , ,222,\n333 ,,",
  })
  assert.deepEqual(loadConfig().discord?.adminRoleIds, ["111", "222", "333"])
})

test("treats an all-separator role list as administrators only", () => {
  setEnv({
    DISCORD_BOT_TOKEN: "token-1",
    DISCORD_GUILD_ID: "guild-1",
    DISCORD_WATCH_CHANNEL_ID: "channel-1",
    DISCORD_ADMIN_ROLE_IDS: " , , ",
  })
  assert.deepEqual(loadConfig().discord?.adminRoleIds, [])
})
