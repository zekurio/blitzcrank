import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { assertSearchScope, type ScopedEpisode } from "./arr.js"

/**
 * The incident these gates come from: a season of 24 episodes that all had
 * files, re-grabbed on release-name language metadata alone.
 */
const season = (count: number, withFiles: number): ScopedEpisode[] =>
  Array.from({ length: count }, (_, i) => ({
    id: 100 + i,
    seasonNumber: 1,
    monitored: true,
    filePath: i < withFiles ? `/mnt/tv/YAIBA/S01E${i + 1}.mkv` : undefined,
  }))

const never = () => false
const always = () => true

describe("assertSearchScope", () => {
  test("allows a single-episode search without any confirmation", () => {
    assertSearchScope({
      episodes: season(1, 1),
      expectedEpisodeCount: undefined,
      probeAvailable: true,
      probed: never,
    })
  })

  test("rejects a search that matches no monitored episode", () => {
    assert.throws(
      () =>
        assertSearchScope({
          episodes: [],
          expectedEpisodeCount: undefined,
          probeAvailable: true,
          probed: always,
        }),
      /matches no monitored episode/,
    )
  })

  test("a season search must state the true episode count", () => {
    assert.throws(
      () =>
        assertSearchScope({
          episodes: season(24, 24),
          expectedEpisodeCount: undefined,
          probeAvailable: true,
          probed: always,
        }),
      /affects 24 episodes \(24 already have a file/,
    )
  })

  test("a wrong episode count is rejected with the real one", () => {
    assert.throws(
      () =>
        assertSearchScope({
          episodes: season(24, 24),
          expectedEpisodeCount: 1,
          probeAvailable: true,
          probed: always,
        }),
      /expectedEpisodeCount: 24/,
    )
  })

  test("replacing many files without a probe is rejected", () => {
    assert.throws(
      () =>
        assertSearchScope({
          episodes: season(24, 24),
          expectedEpisodeCount: 24,
          probeAvailable: true,
          probed: never,
        }),
      /would replace 24 existing episode files/,
    )
  })

  test("a probe of one affected file unlocks the bulk replacement", () => {
    assertSearchScope({
      episodes: season(24, 24),
      expectedEpisodeCount: 24,
      probeAvailable: true,
      probed: (filePath) => filePath === "/mnt/tv/YAIBA/S01E7.mkv",
    })
  })

  test("a probe of some unrelated file does not", () => {
    assert.throws(
      () =>
        assertSearchScope({
          episodes: season(24, 24),
          expectedEpisodeCount: 24,
          probeAvailable: true,
          probed: (filePath) => filePath === "/mnt/tv/Other/S01E01.mkv",
        }),
      /file-level evidence/,
    )
  })

  test("searching for missing episodes needs no probe", () => {
    assertSearchScope({
      episodes: season(24, 0),
      expectedEpisodeCount: 24,
      probeAvailable: true,
      probed: never,
    })
  })

  test("replacing exactly one file needs no probe", () => {
    assertSearchScope({
      episodes: season(1, 1),
      expectedEpisodeCount: undefined,
      probeAvailable: true,
      probed: never,
    })
  })

  test("the probe gate is skipped when probing is unavailable", () => {
    assertSearchScope({
      episodes: season(24, 24),
      expectedEpisodeCount: 24,
      probeAvailable: false,
      probed: never,
    })
  })
})
