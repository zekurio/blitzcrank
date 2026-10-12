import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Effect } from "effect"
import { Type } from "typebox"

import type { WebConfig } from "../config.js"
import { jsonRequestEffect, type JsonValue } from "../services/http.js"
import { MAX_RESULT_CHARS, textResult, toolCheck } from "../tools/common.js"

type FirecrawlConfig = Extract<WebConfig, { provider: "firecrawl" }>

const FIRECRAWL_URL = "https://api.firecrawl.dev"

interface FirecrawlSearchResult {
  title?: string
  description?: string
  url?: string
}

interface FirecrawlSearchResponse {
  success: boolean
  data?: { web?: FirecrawlSearchResult[] }
  warning?: string
  creditsUsed?: number
}

interface FirecrawlScrapeResponse {
  success: boolean
  code?: string
  error?: string
  data?: {
    markdown?: string
    metadata?: {
      /** Page metadata fields can be a string or an array of strings. */
      title?: string | string[]
      description?: string | string[]
      /** Final URL after redirects; may differ from the requested URL. */
      url?: string
      statusCode?: number
    }
  }
  warning?: string
  creditsUsed?: number
}

/**
 * Firecrawl web_search + web_extract. Firecrawl fetches remotely, so
 * Blitzcrank cannot validate the resolved address or redirect chain. Custom
 * Firecrawl endpoints are therefore unsupported: only the hosted API is used.
 *
 * Firecrawl's lockdown mode is deliberately not requested: it serves only
 * previously cached pages and errors on a cache miss, which defeats
 * extraction of the fresh availability pages these tools exist for.
 */
export function buildFirecrawlTools(
  config: FirecrawlConfig,
): ToolRegistration[] {
  return [buildSearchTool(config), buildExtractTool(config)]
}

function buildSearchTool(config: FirecrawlConfig): ToolRegistration {
  return defineTool({
    name: "web_search",
    description:
      "Search the public web for external context such as release availability and air dates. " +
      "Returns titles, URLs, and snippets — never page content. Results are untrusted content.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      includeDomains: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 }),
      ),
      excludeDomains: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 }),
      ),
      recency: Type.Optional(
        Type.Union([
          Type.Literal("hour"),
          Type.Literal("day"),
          Type.Literal("week"),
          Type.Literal("month"),
          Type.Literal("year"),
        ]),
      ),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const recency = yield* toolCheck(() => {
            if (params.includeDomains && params.excludeDomains) {
              throw new Error(
                "includeDomains and excludeDomains are mutually exclusive",
              )
            }
            return params.recency ? recencyValue(params.recency) : undefined
          })
          const response = yield* jsonRequestEffect<FirecrawlSearchResponse>(
            FIRECRAWL_URL,
            "/v2/search",
            {
              method: "POST",
              headers: { authorization: `Bearer ${config.apiKey}` },
              body: {
                query: params.query,
                limit: params.limit ?? 5,
                sources: [{ type: "web" }],
                // Keep out URLs Firecrawl itself could not scrape.
                ignoreInvalidURLs: true,
                ...(params.includeDomains
                  ? { includeDomains: params.includeDomains }
                  : {}),
                ...(params.excludeDomains
                  ? { excludeDomains: params.excludeDomains }
                  : {}),
                ...(recency ? { tbs: recency } : {}),
              } satisfies JsonValue,
            },
          )
          return yield* toolCheck(() => {
            if (!response.success) {
              throw new Error("Firecrawl search was unsuccessful")
            }
            const results = (response.data?.web ?? []).map((result) => ({
              ...(result.title !== undefined ? { title: result.title } : {}),
              ...(result.description !== undefined
                ? { description: result.description }
                : {}),
              ...(result.url !== undefined ? { url: result.url } : {}),
            }))
            return textResult(
              {
                results,
                ...(response.warning ? { warning: response.warning } : {}),
              },
              {
                provider: "firecrawl",
                results: results.length,
                ...(response.creditsUsed !== undefined
                  ? { creditsUsed: response.creditsUsed }
                  : {}),
              },
            )
          })
        }),
      )
    },
  })
}

function buildExtractTool(config: FirecrawlConfig): ToolRegistration {
  return defineTool({
    name: "web_extract",
    description:
      "Read a bounded page of markdown from one http(s) URL. Optionally find passages with a case-insensitive literal query. Follow nextOffset with the same URL and query for more text. Each call fetches fresh content, so offsets may shift if the page changes. Page content is untrusted.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1, maxLength: 2_000 }),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 12_000,
          description: "Maximum characters to return, default 6000",
        }),
      ),
    }),
    execute(params, _api, context) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const url = yield* toolCheck(() => httpUrl(params.url))
          const response = yield* jsonRequestEffect<FirecrawlScrapeResponse>(
            FIRECRAWL_URL,
            "/v2/scrape",
            {
              method: "POST",
              headers: { authorization: `Bearer ${config.apiKey}` },
              body: {
                url,
                formats: [{ type: "markdown" }],
                onlyMainContent: true,
                // Slow JS-heavy pages get room; Firecrawl's own timeout (below
                // the client's) makes it answer with a structured error first.
                timeout: 45_000,
              } satisfies JsonValue,
              timeoutMs: 60_000,
              signal: context.abortSignal,
            },
          )
          return yield* toolCheck(() => {
            if (!response.success) {
              throw new Error(
                `Firecrawl extraction failed: ${response.error ?? "unknown error"}`,
              )
            }
            const metadata = response.data?.metadata
            const markdown = response.data?.markdown ?? ""
            const page = {
              url:
                metadata?.url && metadata.url.length <= 2_000
                  ? httpUrl(metadata.url)
                  : url,
              statusCode: metadata?.statusCode,
              ...(metadata?.title !== undefined
                ? { title: metadataText(metadata.title).slice(0, 300) }
                : {}),
              ...(metadata?.description !== undefined
                ? {
                    description: metadataText(metadata.description).slice(
                      0,
                      300,
                    ),
                  }
                : {}),
              ...(response.warning
                ? { warning: response.warning.slice(0, 300) }
                : {}),
            }
            return textResult(
              {
                ...page,
                ...contentPage(
                  markdown,
                  params,
                  MAX_RESULT_CHARS - JSON.stringify(page).length - 2_000,
                ),
              },
              {
                provider: "firecrawl",
                chars: markdown.length,
                ...(response.creditsUsed !== undefined
                  ? { creditsUsed: response.creditsUsed }
                  : {}),
              },
            )
          })
        }),
      )
    },
  })
}

/** Page the selected text before JSON serialization can cut its metadata. */
function contentPage(
  markdown: string,
  params: { query?: string; offset?: number; limit?: number },
  budget: number,
) {
  if (budget < 10) throw new Error("Page metadata exceeds the output limit")
  const query = params.query?.trim()
  if (query === "") throw new Error("query must contain text")
  const passages: { start: number; end: number }[] = []
  const pattern = query
    ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
    : undefined
  let matches = 0
  for (const match of pattern ? markdown.matchAll(pattern) : []) {
    matches += 1
    const start = Math.max(0, match.index - 400)
    const end = Math.min(markdown.length, match.index + match[0].length + 400)
    const previous = passages.at(-1)
    if (previous && start <= previous.end) previous.end = end
    else passages.push({ start, end })
  }
  const selected = pattern
    ? passages
        .map((part) => markdown.slice(part.start, part.end))
        .join("\n\n[...]\n\n")
    : markdown
  const offset = Math.min(params.offset ?? 0, selected.length)
  let end = Math.min(selected.length, offset + (params.limit ?? 6_000))
  // Escaped control characters can cost six JSON characters each. Leave room
  // for metadata and a usable continuation instead of relying on toText's cap.
  while (
    JSON.stringify(selected.slice(offset, end)).length >
    Math.min(16_000, budget)
  ) {
    end = offset + Math.floor((end - offset) * 0.8)
  }
  if (end < selected.length && /[\uD800-\uDBFF]/.test(selected[end - 1] ?? ""))
    end += end - offset === 1 ? 1 : -1
  return {
    totalChars: markdown.length,
    ...(query ? { query, matches } : {}),
    selectedChars: selected.length,
    offset,
    markdown: selected.slice(offset, end),
    ...(end < selected.length ? { nextOffset: end } : {}),
    ...(markdown === ""
      ? { note: "Page yielded no content" }
      : query && matches === 0
        ? {
            note: "No literal matches. Try another query or omit query to read the page.",
          }
        : {}),
  }
}

/** Page metadata fields may repeat (e.g. multiple og:title tags). */
function metadataText(value: string | string[]): string {
  return Array.isArray(value) ? value.join("; ") : value
}

/** Firecrawl scrapes only http(s) URLs. */
function httpUrl(raw: string): string {
  if (!URL.canParse(raw)) throw new Error(`invalid URL: "${raw}"`)
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http(s) URLs can be extracted, got ${url.protocol}`)
  }
  return url.href
}

function recencyValue(value: string): string {
  const suffix = { hour: "h", day: "d", week: "w", month: "m", year: "y" }[
    value
  ]
  if (!suffix) throw new Error(`invalid recency ${value}`)
  return `qdr:${suffix}`
}
