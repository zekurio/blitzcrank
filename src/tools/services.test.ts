import assert from "node:assert/strict"
import test from "node:test"

import type { ToolRegistration } from "@earendil-works/pi-durable"

import type { JsonValue } from "../services/http.js"
import { buildRadarrTools } from "./arr-radarr.js"
import { buildSonarrTools } from "./arr-sonarr.js"
import { MAX_RESULT_CHARS, ToolError } from "./common.js"
import { RunContext } from "./context.js"
import { isReadTool } from "./index.ts"
import { buildJellyfinTools } from "./jellyfin.js"
import { buildSabnzbdTools } from "./sabnzbd.js"
import { buildSeerrTools } from "./seerr.js"
import { executeTool } from "./test-fixture.js"

function execute(
  tools: ToolRegistration[],
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool)
  return executeTool(tool, params)
}

const cases = [
  {
    service: "radarr",
    build: buildRadarrTools,
    read: "/api/v3/movie/7",
    mutation: "radarr_search",
    params: { movieId: 7 },
    responses: [{ id: 7 }, { id: 71 }, { id: 71, status: "queued" }],
    calls: [
      "GET /api/v3/movie/7",
      "POST /api/v3/command",
      "GET /api/v3/command/71",
    ],
    body: { name: "MoviesSearch", movieIds: [7] },
  },
  {
    service: "sonarr",
    build: (cfg: { url: string; apiKey: string }, ctx: RunContext) =>
      buildSonarrTools(cfg, ctx, false),
    read: "/api/v3/series/7",
    mutation: "sonarr_search",
    params: { seriesId: 7 },
    responses: [
      { id: 7 },
      [{ id: 11, monitored: true, seasonNumber: 1 }],
      { id: 71 },
      { id: 71, status: "queued" },
    ],
    calls: [
      "GET /api/v3/series/7",
      "GET /api/v3/episode?seriesId=7&includeEpisodeFile=true",
      "POST /api/v3/command",
      "GET /api/v3/command/71",
    ],
    body: { name: "SeriesSearch", seriesId: 7 },
  },
  {
    service: "seerr",
    build: buildSeerrTools,
    read: "/api/v1/movie/7",
    mutation: "seerr_create_request",
    params: { mediaType: "movie", mediaId: 7 },
    responses: [{ id: 7 }, { id: 71 }, { id: 71 }],
    calls: [
      "GET /api/v1/movie/7",
      "POST /api/v1/request",
      "GET /api/v1/request/71",
    ],
    body: { mediaType: "movie", mediaId: 7 },
  },
  {
    service: "jellyfin",
    build: buildJellyfinTools,
    read: "/Items/7",
    mutation: "jellyfin_refresh_item",
    params: { itemId: "7" },
    responses: [{ Id: "7" }, undefined],
    calls: ["GET /Items/7", "POST /Items/7/Refresh"],
    body: undefined,
  },
  {
    service: "sabnzbd",
    build: buildSabnzbdTools,
    read: "/api?mode=history",
    mutation: "sabnzbd_retry_job",
    params: { nzoId: "SABnzbd_nzo_7" },
    responses: [
      { history: { slots: [{ nzo_id: "SABnzbd_nzo_7" }] } },
      { status: true },
      { queue: { slots: [] } },
    ],
    calls: [
      "GET /api?mode=history&output=json",
      "GET /api?mode=retry&value=SABnzbd_nzo_7&output=json",
      "GET /api?mode=queue&limit=50&output=json",
    ],
    body: undefined,
  },
]

for (const example of cases) {
  test(`${example.service} tool boundary composes gated reads, writes, and verification`, async (t) => {
    const ctx = new RunContext()
    const tools = example.build(
      { url: "http://service.test", apiKey: "test-key" },
      ctx,
    )
    const calls: string[] = []
    const bodies: JsonValue[] = []
    t.mock.method(globalThis, "fetch", (input: URL, init: RequestInit) => {
      const url = new URL(input)
      const headers = new Headers(init.headers)
      if (example.service === "sabnzbd") {
        assert.equal(url.searchParams.get("apikey"), "test-key")
        url.searchParams.delete("apikey")
      } else if (example.service === "jellyfin") {
        assert.equal(
          headers.get("Authorization"),
          'MediaBrowser Token="test-key"',
        )
      } else {
        assert.equal(headers.get("X-Api-Key"), "test-key")
      }
      const body = example.responses[calls.length]
      calls.push(`${init.method} ${url.pathname}${url.search}`)
      if (init.body) bodies.push(JSON.parse(String(init.body)) as JsonValue)
      return Promise.resolve(
        body === undefined
          ? new Response(null, { status: 204 })
          : Response.json(body),
      )
    })

    const params = { reason: "fix the verified item", ...example.params }
    assert.equal(
      tools.find((tool) => tool.name === `${example.service}_request`)?.replay,
      "safe",
    )
    for (const tool of tools) {
      if (!isReadTool(tool.name)) {
        assert.notEqual(tool.replay, "safe", tool.name)
      }
    }
    await assert.rejects(execute(tools, example.mutation, params), ToolError)
    await assert.rejects(
      execute(tools, `${example.service}_request`, {
        purpose: "reject an absolute service URL",
        path: "http://other.test/7",
      }),
      ToolError,
    )
    assert.deepEqual(calls, [])
    assert.deepEqual(ctx.counts, { mutations: 0, deletes: 0 })

    await execute(tools, `${example.service}_request`, {
      purpose: "inspect item",
      path: example.read,
    })
    const result = await execute(tools, example.mutation, params)
    assert.deepEqual(calls, example.calls)
    assert.deepEqual(bodies, example.body === undefined ? [] : [example.body])
    assert.deepEqual(ctx.counts, { mutations: 1, deletes: 0 })
    assert.ok(result.content)
    assert.equal(result.content[0]?.type, "text")
    if (result.content[0]?.type === "text") {
      const outcome = JSON.parse(result.content[0].text) as {
        verificationError?: string
      }
      assert.equal(outcome.verificationError, undefined)
    }
    if (["radarr", "sonarr", "seerr"].includes(example.service)) {
      assert.equal(ctx.sawValue(example.service, 71), true)
    }
  })
}

function release(
  title: string,
  publishDate: string,
  episodeId: number,
  extra: Record<string, JsonValue> = {},
): Record<string, JsonValue> {
  return {
    guid: `https://indexer.test/${title}`,
    title,
    publishDate,
    indexer: "Indexer",
    protocol: "usenet",
    size: 1_400_000_000,
    quality: { quality: { id: 3, name: "WEBDL-1080p" } },
    languages: [{ id: 8, name: "Japanese" }],
    customFormats: [{ id: 1, name: "1080p" }],
    customFormatScore: 50,
    mappedSeriesId: 7,
    mappedSeasonNumber: 2,
    mappedEpisodeNumbers: [1],
    mappedAbsoluteEpisodeNumbers: [171],
    mappedEpisodeInfo: [{ id: episodeId, seasonNumber: 2, episodeNumber: 1 }],
    approved: false,
    rejections: [],
    ...extra,
  }
}

function resultText(result: Awaited<ReturnType<typeof execute>>): string {
  const content = result.content?.[0]
  assert.equal(content?.type, "text")
  return content?.type === "text" ? content.text : ""
}

const existingFileRejection =
  "Existing file on disk has a equal or higher Custom Format score: 13800"

test("sonarr_releases counts every hit and lists filtered target releases", async (t) => {
  const ctx = new RunContext()
  const tools = buildSonarrTools(
    { url: "http://service.test", apiKey: "test-key" },
    ctx,
    false,
  )
  const calls: string[] = []
  t.mock.method(globalThis, "fetch", (input: URL, init: RequestInit) => {
    const url = new URL(input)
    calls.push(`${init.method} ${url.pathname}${url.search}`)
    return Promise.resolve(
      Response.json([
        release("Old.S02E01-WAREZCX", "2024-11-25T10:00:00Z", 11, {
          approved: true,
          customFormatScore: 13800,
        }),
        release("Old.S02E01-WAREZCX", "2025-01-06T10:00:00Z", 11, {
          approved: true,
          customFormatScore: 13800,
        }),
        release("New.S02E01-DRiFTKiNG", "2026-10-03T10:00:00Z", 11, {
          rejections: [existingFileRejection],
        }),
        release("Show.S01E01-ABJ", "2022-01-01T00:00:00Z", 99, {
          mappedSeasonNumber: 1,
        }),
        {
          title: "Unparseable",
          publishDate: "2026-10-04T00:00:00Z",
          approved: false,
          rejections: ["Unable to identify correct episode(s)"],
        },
      ]),
    )
  })
  assert.equal(
    tools.find((tool) => tool.name === "sonarr_releases")?.replay,
    "safe",
  )

  const result = await execute(tools, "sonarr_releases", {
    purpose: "find continuation releases",
    episodeId: 11,
    publishedAfter: "2026-10-01",
  })

  assert.deepEqual(calls, ["GET /api/v3/release?episodeId=11"])
  assert.deepEqual(JSON.parse(resultText(result)), {
    total: 5,
    forTarget: 3,
    approvedForTarget: 2,
    matchingFilters: 1,
    listed: 1,
    rejectionsInMatching: [{ reason: existingFileRejection, count: 1 }],
    otherTargets: { count: 2, examples: ["Show.S01E01-ABJ", "Unparseable"] },
    releases: [
      {
        title: "New.S02E01-DRiFTKiNG",
        published: "2026-10-03",
        indexer: "Indexer",
        protocol: "usenet",
        sizeMb: 1400,
        quality: "WEBDL-1080p",
        languages: ["Japanese"],
        customFormatScore: 50,
        customFormats: ["1080p"],
        approved: false,
        rejections: [existingFileRejection],
        episodes: "S2E1",
        absolute: [171],
      },
    ],
  })
})

test("sonarr_releases caps the listing and maps season searches by series", async (t) => {
  const tools = buildSonarrTools(
    { url: "http://service.test", apiKey: "test-key" },
    new RunContext(),
    false,
  )
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      Response.json([
        release("A.S02E01-WAREZCX", "2024-11-25T10:00:00Z", 11),
        release("B.S02E02-WAREZCX", "2024-11-25T10:00:00Z", 12),
        release("C.S02E03-WAREZCX", "2024-11-25T10:00:00Z", 13),
        release("D.S02E01-WAREZCX", "2024-11-25T10:00:00Z", 11, {
          mappedSeriesId: 8,
        }),
      ]),
    ),
  )

  const result = await execute(tools, "sonarr_releases", {
    purpose: "inspect season candidates",
    seriesId: 7,
    seasonNumber: 2,
    titleContains: "warezcx",
    limit: 2,
  })

  const body = JSON.parse(resultText(result)) as {
    forTarget: number
    matchingFilters: number
    listed: number
    releases: { title: string }[]
  }
  assert.equal(body.forTarget, 3)
  assert.equal(body.matchingFilters, 3)
  assert.equal(body.listed, 2)
  assert.deepEqual(
    body.releases.map((entry) => entry.title),
    ["A.S02E01-WAREZCX", "B.S02E02-WAREZCX"],
  )
})

test("release candidates are read only through the summarizing tools", async (t) => {
  const tools = buildSonarrTools(
    { url: "http://service.test", apiKey: "test-key" },
    new RunContext(),
    false,
  )
  const calls: string[] = []
  t.mock.method(globalThis, "fetch", (input: URL) => {
    const url = new URL(input)
    calls.push(`${url.pathname}${url.search}`)
    return Promise.resolve(Response.json([]))
  })

  for (const path of [
    "/api/v3/release?episodeId=11",
    "/api/v3/Release/?seriesId=7&seasonNumber=2",
  ]) {
    await assert.rejects(
      execute(tools, "sonarr_request", { purpose: "raw candidates", path }),
      /sonarr_releases/,
    )
  }
  await assert.rejects(
    execute(tools, "sonarr_releases", {
      purpose: "ambiguous target",
      episodeId: 11,
      seriesId: 7,
    }),
    ToolError,
  )
  await assert.rejects(
    execute(tools, "sonarr_releases", {
      purpose: "season without series",
      seasonNumber: 2,
    }),
    ToolError,
  )
  assert.deepEqual(calls, [])

  await execute(tools, "sonarr_request", {
    purpose: "release profiles stay readable",
    path: "/api/v3/releaseprofile",
  })
  assert.deepEqual(calls, ["/api/v3/releaseprofile"])
})

test("radarr_releases lists only releases mapped to the movie", async (t) => {
  const tools = buildRadarrTools(
    { url: "http://service.test", apiKey: "test-key" },
    new RunContext(),
  )
  const calls: string[] = []
  t.mock.method(globalThis, "fetch", (input: URL) => {
    const url = new URL(input)
    calls.push(`${url.pathname}${url.search}`)
    return Promise.resolve(
      Response.json([
        { title: "Movie.2026.1080p", mappedMovieId: 7, approved: true },
        { title: "Other.Movie.2026.1080p", mappedMovieId: 8, approved: true },
        { title: "Unmapped.1080p", mappedMovieId: null, approved: false },
      ]),
    )
  })

  const result = await execute(tools, "radarr_releases", {
    purpose: "movie candidates",
    movieId: 7,
  })

  assert.deepEqual(calls, ["/api/v3/release?movieId=7"])
  const body = JSON.parse(resultText(result)) as {
    forTarget: number
    approvedForTarget: number
    otherTargets: { count: number }
    releases: { title: string }[]
  }
  assert.equal(body.forTarget, 1)
  assert.equal(body.approvedForTarget, 1)
  assert.equal(body.otherTargets.count, 2)
  assert.deepEqual(
    body.releases.map((entry) => entry.title),
    ["Movie.2026.1080p"],
  )
})

test("sonarr_releases trims the listing to fit one result as valid JSON", async (t) => {
  const tools = buildSonarrTools(
    { url: "http://service.test", apiKey: "test-key" },
    new RunContext(),
    false,
  )
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      Response.json(
        Array.from({ length: 50 }, (_, index) =>
          release(
            `${index}.${"Long.Release.Title.".repeat(40)}`,
            "2026-10-03T10:00:00Z",
            11,
          ),
        ),
      ),
    ),
  )

  const text = resultText(
    await execute(tools, "sonarr_releases", {
      purpose: "many long candidates",
      episodeId: 11,
      limit: 50,
    }),
  )

  const body = JSON.parse(text) as { listed: number; releases: unknown[] }
  assert.ok(text.length <= MAX_RESULT_CHARS)
  assert.ok(body.listed > 0 && body.listed < 50)
  assert.equal(body.releases.length, body.listed)
})
