import assert from "node:assert/strict"
import test from "node:test"

import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

import { HttpError } from "../services/http.js"
import { ToolError } from "../tools/common.js"
import { buildFirecrawlTools } from "./firecrawl.js"

function execute(
  tools: ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool)
  return tool.execute("test", params, undefined, undefined, undefined as never)
}

test("web Effects preserve the per-run extraction gate and hosted API boundary", async (t) => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test")
    calls.push({
      url: input.href,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    })
    return Response.json(
      input.pathname === "/v2/search"
        ? {
            success: true,
            data: {
              web: [
                {
                  title: "Available",
                  url: "https://example.com/release#search",
                },
                { url: "http://127.0.0.1/private" },
              ],
            },
          }
        : {
            success: true,
            data: {
              markdown: "Release details",
              metadata: { title: ["One", "Two"] },
            },
          },
    )
  })
  const config = { provider: "firecrawl" as const, apiKey: "test" }
  const tools = buildFirecrawlTools(config)
  await assert.rejects(
    execute(tools, "web_extract", { url: "https://example.com/release" }),
    ToolError,
  )
  await assert.rejects(
    execute(tools, "web_search", {
      query: "release",
      includeDomains: ["example.com"],
      excludeDomains: ["example.net"],
    }),
    /mutually exclusive/,
  )
  assert.equal(calls.length, 0)
  await execute(tools, "web_search", { query: "release", recency: "week" })
  assert.equal(calls[0]?.body.tbs, "qdr:w")
  assert.equal(calls[0]?.body.ignoreInvalidURLs, true)
  await assert.rejects(
    execute(tools, "web_extract", { url: "http://127.0.0.1/private" }),
    /non-public/,
  )
  assert.equal(calls.length, 1)
  const result = await execute(tools, "web_extract", {
    url: "https://example.com/release#another",
  })
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://api.firecrawl.dev/v2/search",
      "https://api.firecrawl.dev/v2/scrape",
    ],
  )
  assert.equal(calls[1]?.body.url, "https://example.com/release")
  assert.equal(calls[1]?.body.timeout, 45_000)
  assert.equal(result.content[0]?.type, "text")
  assert.match(JSON.stringify(result.content), /One; Two/)
  await assert.rejects(
    execute(buildFirecrawlTools(config), "web_extract", {
      url: "https://example.com/release",
    }),
    /search first/,
  )
  assert.equal(calls.length, 2)
})

test("unsuccessful web responses remain typed failures without retries", async (t) => {
  let requests = 0
  t.mock.method(globalThis, "fetch", async () => {
    requests++
    return requests === 1
      ? Response.json({ success: false })
      : Response.json({ error: "unavailable" }, { status: 503 })
  })
  const tools = buildFirecrawlTools({ provider: "firecrawl", apiKey: "test" })
  await assert.rejects(
    execute(tools, "web_search", { query: "release" }),
    ToolError,
  )
  await assert.rejects(
    execute(tools, "web_search", { query: "release" }),
    HttpError,
  )
  assert.equal(requests, 2)
})
