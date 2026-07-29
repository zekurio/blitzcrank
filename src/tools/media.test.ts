import assert from "node:assert/strict"
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"

import { largestMediaFile, resolveMediaPath, summarizeProbe } from "./media.js"

/**
 * Real temp directories, no mocks: the containment guard is only meaningful
 * against actual symlinks and `..` segments.
 */
let base: string
let root: string
let outside: string

before(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "blitzcrank-media-")))
  root = path.join(base, "media")
  outside = path.join(base, "secrets")
  await mkdir(path.join(root, "Show", "Season 01"), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(outside, "private.mkv"), "x")
  await writeFile(path.join(root, "Show", "Season 01", "s01e01.mkv"), "video")
  await symlink(
    path.join(outside, "private.mkv"),
    path.join(root, "escape.mkv"),
  )
})

after(() => rm(base, { recursive: true, force: true }))

describe("resolveMediaPath", () => {
  test("accepts a file inside a configured root", async () => {
    const file = path.join(root, "Show", "Season 01", "s01e01.mkv")
    assert.equal(await resolveMediaPath(file, [root]), file)
  })

  test("rejects relative paths", async () => {
    await assert.rejects(
      () => resolveMediaPath("Show/Season 01/s01e01.mkv", [root]),
      /absolute filesystem path/,
    )
  })

  test("rejects traversal out of the root", async () => {
    await assert.rejects(
      () => resolveMediaPath(path.join(root, "..", "secrets"), [root]),
      /outside the media roots/,
    )
  })

  test("rejects a symlink inside the root that escapes it", async () => {
    await assert.rejects(
      () => resolveMediaPath(path.join(root, "escape.mkv"), [root]),
      /outside the media roots/,
    )
  })

  test("rejects a sibling directory sharing the root's prefix", async () => {
    await assert.rejects(
      () => resolveMediaPath(`${root}-other`, [root]),
      /ENOENT|outside the media roots/,
    )
  })

  test("resolves a root that is itself a symlink", async () => {
    const link = path.join(path.dirname(root), "library")
    await symlink(root, link)
    const file = path.join(link, "Show", "Season 01", "s01e01.mkv")
    assert.equal(
      await resolveMediaPath(file, [link]),
      path.join(root, "Show", "Season 01", "s01e01.mkv"),
    )
  })
})

describe("largestMediaFile", () => {
  test("picks the largest media file below a release directory", async () => {
    const release = path.join(root, "complete", "Show.S01E02.MULTi.1080p")
    await mkdir(path.join(release, "Subs"), { recursive: true })
    await writeFile(path.join(release, "sample.mkv"), "small")
    await writeFile(path.join(release, "release.nfo"), "x".repeat(999))
    await writeFile(path.join(release, "episode.mkv"), "x".repeat(500))
    await writeFile(path.join(release, "Subs", "extra.mkv"), "x".repeat(100))
    const found = await largestMediaFile(release)
    assert.equal(found?.path, path.join(release, "episode.mkv"))
    assert.equal(found?.size, 500)
  })

  test("skips symlinked entries so the walk stays inside the root", async () => {
    const dir = path.join(root, "linked")
    await mkdir(dir, { recursive: true })
    await symlink(path.join(outside, "private.mkv"), path.join(dir, "big.mkv"))
    assert.equal(await largestMediaFile(dir), undefined)
  })

  test("returns undefined when a directory holds no media file", async () => {
    const dir = path.join(root, "empty")
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "readme.txt"), "x")
    assert.equal(await largestMediaFile(dir), undefined)
  })
})

describe("summarizeProbe", () => {
  // A MULTi-named release whose file carries no German track at all.
  const ffprobeJson = JSON.stringify({
    streams: [
      {
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        disposition: { default: 1, forced: 0 },
      },
      {
        index: 1,
        codec_type: "audio",
        codec_name: "aac",
        channels: 2,
        channel_layout: "stereo",
        disposition: { default: 1, forced: 0 },
        tags: { language: "jpn", title: "Japanese" },
      },
      {
        index: 2,
        codec_type: "audio",
        codec_name: "aac",
        channels: 2,
        disposition: { default: 0, forced: 0 },
        tags: { language: "eng" },
      },
      {
        index: 3,
        codec_type: "subtitle",
        codec_name: "subrip",
        disposition: { default: 0, forced: 1 },
        tags: { language: "eng", title: "Forced" },
      },
      { index: 4, codec_type: "audio", codec_name: "ac3" },
    ],
    format: { duration: "1412.480000" },
  })

  test("summarizes audio and subtitle languages from stream tags", () => {
    const summary = summarizeProbe(ffprobeJson)
    assert.deepEqual(summary.audioLanguages, ["jpn", "eng", "und"])
    assert.deepEqual(summary.subtitleLanguages, ["eng"])
    assert.ok(!summary.audioLanguages.includes("ger"))
    assert.equal(summary.durationSeconds, 1412)
    assert.equal(summary.truncated, false)
  })

  test("keeps per-stream detail needed to judge a track", () => {
    const summary = summarizeProbe(ffprobeJson)
    assert.deepEqual(summary.streams[1], {
      index: 1,
      type: "audio",
      codec: "aac",
      language: "jpn",
      title: "Japanese",
      channels: 2,
      layout: "stereo",
      default: true,
    })
    assert.deepEqual(summary.streams[3], {
      index: 3,
      type: "subtitle",
      codec: "subrip",
      language: "eng",
      title: "Forced",
      forced: true,
    })
  })

  test("tolerates a file with no streams", () => {
    const summary = summarizeProbe(JSON.stringify({ streams: [] }))
    assert.deepEqual(summary.audioLanguages, [])
    assert.deepEqual(summary.subtitleLanguages, [])
    assert.equal(summary.durationSeconds, undefined)
  })
})
