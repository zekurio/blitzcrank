import assert from "node:assert/strict"
import test from "node:test"

import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

import type { JsonValue } from "../services/http.js"
import { buildRadarrTools } from "./arr-radarr.js"
import { buildSonarrTools } from "./arr-sonarr.js"
import { ToolError } from "./common.js"
import { RunContext } from "./context.js"
import { buildJellyfinTools } from "./jellyfin.js"
import { buildSabnzbdTools } from "./sabnzbd.js"
import { buildSeerrTools } from "./seerr.js"

function execute(
  tools: ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool)
  return tool.execute("test", params, undefined, undefined, undefined as never)
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
      } else {
        assert.equal(
          headers.get(
            example.service === "jellyfin" ? "X-Emby-Token" : "X-Api-Key",
          ),
          "test-key",
        )
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
