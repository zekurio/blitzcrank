import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { buildSystemPrompt } from "../agent/prompt.ts"
import { emptyCase } from "../casefile.ts"
import type { Config } from "../config.ts"
import { SeerrClient } from "../services/seerr.ts"
import { RunContext } from "./context.ts"
import {
  buildDiscordTools,
  buildIssueTools,
  buildServiceTools,
  isReadTool,
} from "./index.ts"
import { buildMediaFramesTool } from "./media-frames.ts"

const run = promisify(execFile)

function execute(
  tool: ReturnType<typeof buildMediaFramesTool>,
  file: string,
  times: number[],
  signal?: AbortSignal,
) {
  return tool.execute(
    "test",
    {
      purpose: "Check the reported episode",
      path: file,
      timestampsSeconds: times,
    },
    signal,
    undefined,
    undefined as never,
  )
}

test("frame tool follows current model capabilities and configured roots", () => {
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
  const ctx = new RunContext()
  for (const builder of [buildServiceTools, buildDiscordTools]) {
    for (const input of [[], ["text"], ["text", "image"], ["text"]] as const) {
      const tools = builder(config, ctx, { current: undefined }, input)
      const names = tools.map((tool) => tool.name)
      const expected = input.some((type) => type === "image")
      assert.equal(names.includes("media_frames"), expected)
      assert.equal(
        buildSystemPrompt(
          config,
          { search: undefined, extract: undefined },
          names,
        ).includes("`media_frames`"),
        expected,
      )
    }
    assert.equal(
      builder({ ...config, media: undefined }, ctx, { current: undefined }, [
        "image",
      ]).some((tool) => tool.name === "media_frames"),
      false,
    )
    assert.equal(
      builder(
        { ...config, media: { roots: [] } },
        ctx,
        { current: undefined },
        ["image"],
      ).some((tool) => tool.name === "media_frames"),
      false,
    )
  }
  assert.equal(isReadTool("media_frames"), true)
  assert.equal(isReadTool("anvil_retry_job"), false)
  for (const modelInput of [["text", "image"], ["text"]] as const) {
    const tools = buildIssueTools({
      config,
      ctx,
      modelInput,
      seerr: new SeerrClient(config.seerr, undefined),
      issueId: "17",
      anchor: "test",
      sessionFileRef: { current: undefined },
      mediaScope: "movie",
      status: { id: undefined },
      casefile: emptyCase("17"),
    })
    const names = tools.map((tool) => tool.name)
    assert.equal(
      names.includes("media_frames"),
      modelInput.some((type) => type === "image"),
    )
    assert.equal(
      names.some((name) => name.startsWith("sonarr_")),
      false,
    )
  }
  const noAnvil = { ...config, anvil: undefined }
  const names = buildServiceTools(noAnvil, ctx, { current: undefined }, [
    "image",
  ]).map((tool) => tool.name)
  assert.ok(
    buildSystemPrompt(
      noAnvil,
      { search: undefined, extract: undefined },
      names,
    ).includes("`media_frames`"),
  )
})

test("frames decode at requested positions without recording mutation evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-frames-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const media = path.join(root, "media")
  await mkdir(media)
  const file = path.join(media, "episode.mkv")
  await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=2:duration=3",
    "-c:v",
    "ffv1",
    file,
  ])
  const ctx = new RunContext()
  ctx.recordPath("sonarr", file, "path")
  const before = ctx.snapshot
  const tool = buildMediaFramesTool({ roots: [media] }, ctx)
  const result = await execute(tool, file, [0, 1, 2])
  const images = result.content.filter((part) => part.type === "image")
  assert.equal(images.length, 3)
  assert.equal(new Set(images.map((image) => image.data)).size, 3)
  assert.deepEqual(result.details.timestampsSeconds, [0, 1, 2])
  for (const [index, image] of images.entries()) {
    const bytes = Buffer.from(image.data, "base64")
    assert.equal(image.mimeType, "image/jpeg")
    assert.ok(bytes.length <= 512 * 1024)
    const jpeg = path.join(root, `frame-${index}.jpg`)
    await writeFile(jpeg, bytes)
    const probe = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      jpeg,
    ])
    assert.equal(probe.stdout.trim(), "960,540")
  }
  assert.deepEqual(ctx.snapshot, before)
  await assert.rejects(execute(tool, file, [100]), /no video frame/)
  for (const times of [
    [],
    [0, 0],
    [-1],
    [NaN],
    [Infinity],
    [0, 1, 2, 3, 4, 5, 6],
  ]) {
    await assert.rejects(execute(tool, file, times), /one to six/)
  }
  await assert.rejects(execute(tool, file, [0], AbortSignal.abort()), /abort/i)
  const fresh = buildMediaFramesTool(
    { roots: [media] },
    new RunContext({ prior: ctx.snapshot }),
  )
  await assert.rejects(execute(fresh, file, [0]), /evidence gate/)
  ctx.recordPath("sonarr", media)
  await assert.rejects(execute(tool, media, [0]), /regular file/)
  const outside = path.join(root, "outside.mkv")
  await writeFile(outside, "outside")
  const link = path.join(media, "link.mkv")
  await symlink(outside, link)
  ctx.recordPath("sonarr", link)
  await assert.rejects(execute(tool, link, [0]), /not inside/)
  const playlist = path.join(media, "playlist.m3u8")
  await writeFile(
    playlist,
    "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nhttp://127.0.0.1:1/secret.ts\n#EXT-X-ENDLIST\n",
  )
  ctx.recordPath("sonarr", playlist)
  await assert.rejects(execute(tool, playlist, [0]), /whitelist|Invalid data/)
})
