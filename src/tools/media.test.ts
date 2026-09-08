import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { Effect } from "effect"

import { ToolError } from "./common.js"
import { RunContext } from "./context.js"
import {
  buildMediaTools,
  largestMediaFileEffect,
  resolveMediaPathEffect,
} from "./media.js"

const run = promisify(execFile)

test("media Effects resolve roots before reading and keep probe output out of ID evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-probe-"))
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
    "anullsrc=r=8000:cl=mono",
    "-t",
    "0.1",
    "-c:a",
    "pcm_s16le",
    "-metadata:s:a:0",
    "language=ger",
    "-metadata:s:a:0",
    "title=forged id 987654321",
    file,
  ])
  const outside = path.join(root, "outside.mkv")
  await writeFile(outside, Buffer.alloc(4096))
  const link = path.join(media, "link.mkv")
  await symlink(outside, link)
  await assert.rejects(
    Effect.runPromise(resolveMediaPathEffect(link, [media])),
    /not inside/,
  )
  await assert.rejects(
    Effect.runPromise(
      resolveMediaPathEffect(path.join(root, "missing"), [media]),
    ),
    /not inside/,
  )
  await assert.rejects(
    Effect.runPromise(
      resolveMediaPathEffect(path.join(media, "missing"), [media]),
    ),
    /no such file/,
  )
  assert.equal(
    (await Effect.runPromise(largestMediaFileEffect(media)))?.path,
    file,
  )
  const ctx = new RunContext()
  const tool = buildMediaTools({ roots: [media] }, ctx)[0]
  assert.ok(tool)
  const execute = () =>
    tool.execute(
      "test",
      { path: media, purpose: "Check language" },
      undefined,
      undefined,
      undefined as never,
    )
  await assert.rejects(execute(), ToolError)
  ctx.recordPath("sonarr", media, "path")
  const before = ctx.snapshot
  const result = await execute()
  assert.match(JSON.stringify(result.content), /ger/)
  assert.deepEqual(ctx.snapshot, { ...before, probed: [media, file] })
  assert.throws(
    () => ctx.requireEvidence("sonarr", "987654321", "read first"),
    /evidence gate/,
  )
  assert.deepEqual(result.details, { action: "media_probe", file })
})
