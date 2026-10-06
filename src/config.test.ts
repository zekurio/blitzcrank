import assert from "node:assert/strict"
import test from "node:test"

import { loadConfig } from "./config.ts"

/** Every variable loadConfig reads belongs to one of these deployment prefixes. */
const DEPLOYMENT_ENV =
  /^(?:BLITZCRANK|SEERR|SONARR|RADARR|SABNZBD|JELLYFIN|DISCORD|FIRECRAWL)_/

/**
 * loadConfig reads process.env directly, so tests clear any exported deployment
 * environment first and restore it afterwards.
 */
function withEnv(
  values: Record<string, string | undefined>,
  run: () => void,
): void {
  const saved = Object.entries(process.env).filter(([key]) =>
    DEPLOYMENT_ENV.test(key),
  )
  const clear = () => {
    for (const key of Object.keys(process.env)) {
      if (DEPLOYMENT_ENV.test(key)) delete process.env[key]
    }
  }
  clear()
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value
    }
    run()
  } finally {
    clear()
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value
    }
  }
}

const SEERR_ENV = { SEERR_URL: "http://seerr.test", SEERR_API_KEY: "test" }

test("a missing BLITZCRANK_MODEL stops startup", () => {
  withEnv(SEERR_ENV, () => {
    assert.throws(() => loadConfig(), /BLITZCRANK_MODEL/)
  })
})

test("an empty BLITZCRANK_MODEL stops startup", () => {
  withEnv({ ...SEERR_ENV, BLITZCRANK_MODEL: "" }, () => {
    assert.throws(() => loadConfig(), /BLITZCRANK_MODEL/)
  })
})

test("a whitespace-only BLITZCRANK_MODEL stops startup", () => {
  withEnv({ ...SEERR_ENV, BLITZCRANK_MODEL: "   " }, () => {
    assert.throws(() => loadConfig(), /BLITZCRANK_MODEL/)
  })
})

test("an explicit BLITZCRANK_MODEL is kept verbatim", () => {
  withEnv(
    { ...SEERR_ENV, BLITZCRANK_MODEL: "anthropic/claude-sonnet-4-5:high" },
    () => {
      const config = loadConfig()
      assert.equal(config.model, "anthropic/claude-sonnet-4-5:high")
      assert.equal(config.automationModel, undefined)
    },
  )
})

test("an automation override stays an addition to the base model", () => {
  withEnv(
    {
      ...SEERR_ENV,
      BLITZCRANK_MODEL: "anthropic/claude-sonnet-4-5",
      BLITZCRANK_AUTOMATION_MODEL: "anthropic/claude-haiku-4-5:low",
    },
    () => {
      const config = loadConfig()
      assert.equal(config.model, "anthropic/claude-sonnet-4-5")
      assert.equal(config.automationModel, "anthropic/claude-haiku-4-5:low")
    },
  )
})
