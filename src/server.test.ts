import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import type { Config } from "./config.ts"
import { createApp } from "./server.ts"

test("Seerr commands require authorization and never enqueue agent work", async (t) => {
  const config: Config = {
    port: 0,
    dataDir: "/tmp/blitzcrank-test",
    automationsDir: "/tmp/blitzcrank-test/automations",
    webhookSecret: undefined,
    model: undefined,
    automationModel: undefined,
    automationModels: {},
    authPath: undefined,
    modelsPath: undefined,
    language: "English",
    web: { provider: "none" },
    seerrBotUserId: undefined,
    seerrBotUsername: undefined,
    seerr: { url: "http://seerr.test", apiKey: "test" },
    sonarr: { url: "http://sonarr.test", apiKey: "test" },
    radarr: { url: "http://radarr.test", apiKey: "test" },
    sabnzbd: { url: "http://sabnzbd.test", apiKey: "test" },
    jellyfin: { url: "http://jellyfin.test", apiKey: "test" },
    anvil: { command: "anvilctl", socket: "/tmp/anvil.sock" },
    media: { roots: ["/tmp/media"] },
    discord: undefined,
  }
  let allowed = false
  let unavailable = false
  const calls: string[] = []
  const server = createServer(
    createApp({
      config,
      async allowComment() {
        if (unavailable) throw new Error("Seerr unavailable")
        return allowed
      },
      async onIssueStop(id) {
        calls.push(`stop:${id}`)
      },
      async onIssueResume(id) {
        calls.push(`resume:${id}`)
      },
      async onIssueEvent(id) {
        calls.push(`event:${id}`)
        return "paused"
      },
      async onIssueClosed() {},
      listAutomations: () => [],
      triggerAutomation: () => "unknown",
      stats: () => ({ queued: 0, pendingRevisits: 0 }),
    }),
  )
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  )
  const address = server.address()
  assert(address && typeof address !== "string")
  const post = (command: string) =>
    fetch(`http://127.0.0.1:${address.port}/webhook/seerr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notification_type: "ISSUE_COMMENT",
        issue: { issue_id: "12" },
        comment: { comment_message: command, commentedBy_username: "reporter" },
      }),
    })
  await post("/blitzcrank stop")
  await post("/blitzcrank resume")
  assert.deepEqual(calls, [])
  allowed = true
  assert.deepEqual(await (await post(" /BLITZCRANK STOP ")).json(), {
    ok: true,
    command: "stopped",
  })
  assert.deepEqual(await (await post("/blitzcrank resume")).json(), {
    ok: true,
    command: "resumed",
  })
  assert.deepEqual(calls, ["stop:12", "resume:12"])
  assert.deepEqual(await (await post("Normal comment")).json(), {
    ok: true,
    ignored: "issue paused",
  })
  unavailable = true
  assert.equal((await post("/blitzcrank stop")).status, 500)
  assert.deepEqual(calls, ["stop:12", "resume:12", "event:12"])
})
