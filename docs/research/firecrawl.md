# Firecrawl web provider

Research date: 2026-08-18, against `docs.firecrawl.dev` v2 OpenAPI references
for `POST /search` and `POST /scrape` plus the Lockdown Mode feature page.

Blitzcrank's `web_search`/`web_extract` (`src/web/`) are read-only typed
tools for issue runs and Discord conversation replies, backed by Firecrawl's
hosted v2 REST API at `https://api.firecrawl.dev`. Selected with
`BLITZCRANK_WEB_PROVIDER=firecrawl` and `FIRECRAWL_API_KEY`. `none` (the
default) grants no external web tools. Custom endpoints are rejected because
Blitzcrank cannot validate the DNS answers and redirect chain used by a remote
fetcher. Web tools are not service reads: they never call `ctx.recordRead`, so
web content can never satisfy an evidence gate.

## Search: `POST https://api.firecrawl.dev/v2/search`

Bearer auth. Request fields used:

- `query` (required, max 500 chars), `limit` (1–100; the tool clamps to 1–10,
  default 5), `sources: [{ "type": "web" }]`.
- `includeDomains` / `excludeDomains`: hostname arrays, mutually exclusive
  (the tool throws before sending both).
- `tbs`: time filter; the tool maps its `recency` enum to `qdr:h|d|w|m|y`.
- `ignoreInvalidURLs: true`: drops results Firecrawl itself could not scrape,
  keeping every returned URL a valid extraction target.
- `scrapeOptions` would inline full page content per result; the tool never
  sends it — extraction is a separate, individually visible and chargeable
  call (`web_extract`).

Response: `{ success, data: { web: [{ title, description, url }] }, warning,
creditsUsed }`. `markdown`/`html` only appear when `scrapeOptions` was sent.

## Scrape: `POST https://api.firecrawl.dev/v2/scrape`

Request fields used: `url`, `formats: [{ "type": "markdown" }]`,
`onlyMainContent: true` (deterministic HTML-level boilerplate filter, no
LLM), `timeout: 45000` (below the client's 60 s so Firecrawl answers with a
structured timeout error first). `maxAge` defaults to 2 days: a fresh-enough
cached page is served, otherwise Firecrawl scrapes live.

Response: `{ success, code?, error?, data: { markdown, metadata: { title,
description, url, statusCode, ... } }, warning, creditsUsed }`. `metadata.url`
is the final URL after redirects; `title`/`description` may be string **or
string[]** (repeated meta tags). Failures arrive as non-2xx (`HttpError`) or
`success: false` with `code`/`error`.

## Network boundary and lockdown mode

Firecrawl performs the target request, DNS resolution, and redirects. A client
side hostname check cannot prove where a custom Firecrawl deployment will
connect: its DNS view can differ from Blitzcrank's, answers can change after a
check, and redirects are visible only to the fetcher. Blitzcrank therefore
uses only Firecrawl's hosted API and rejects `FIRECRAWL_URL`. This keeps a web
result from turning a Firecrawl container on the homelab network into an SSRF
path to private services.

`lockdown: true` forces cache-only scrapes: no outbound request to the target,
a cache miss returns 404 `SCRAPE_LOCKDOWN_CACHE_MISS`, and requests are
zero-data-retention. It exists for compliance/air-gapped replay of
already-indexed pages. The tools' purpose is checking _fresh_ availability
pages, which are usually not cached, so lockdown would make `web_extract`
mostly fail. It is not requested.

Two narrower controls still apply:

1. **Per-run search→extract gate** — `web_extract` accepts only URLs a
   `web_search` returned earlier in the same run (normalized `URL.href`,
   fragment stripped, set capped at 100). Both tools are rebuilt per run, so
   the gate cannot leak across runs.
2. **Public-literal guard** — extract rejects non-http(s) schemes, embedded
   credentials, `localhost`/`*.localhost`/`*.local`/`*.internal`, and
   private/reserved IP literals: IPv4 0/8, 10/8, 100.64/10, 127/8,
   169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4+240/4;
   IPv6 `::`, `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped `::ffff:*`
   (range-checked after WHATWG normalization to hex hextets). WHATWG parsing
   itself collapses odd IPv4 spellings (`0x7f.1`, `2130706433`) to dotted
   quads before these checks. The guard rejects direct literals and is not a
   substitute for fetcher-side DNS and redirect enforcement.
