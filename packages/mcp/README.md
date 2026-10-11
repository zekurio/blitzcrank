# @blitzcrank/mcp

The Blitzcrank MCP server. It holds the service credentials and media mounts
and exposes typed reads and plan/apply writes for Seerr, Sonarr, Radarr,
SABnzbd, and Jellyfin over the Model Context Protocol (Streamable HTTP). The
host (`packages/host`) connects to it at the start of every issue run, exposes
read-only tools to codemode scripts, and registers the write tools directly.

This file is the contract between the two packages. Change it together with
both sides.

## Process

- Binary: `blitzcrank-mcp` (`dist/cli.js`). No arguments.
- Transport: MCP Streamable HTTP, stateless (no session id generator, JSON
  responses enabled), served by Node's `http` module at `POST /mcp`. Every
  request gets a fresh SDK `Server` and transport over the shared tools and
  plan store. `GET /healthz` answers `200 ok` without authentication. Any
  other method on `/mcp` answers `405` once the token checks out: the server
  offers no stream and has no session to delete. Everything else is `404`. A
  request body over 1 MiB is `413`.
- Authentication: every `/mcp` request must carry
  `Authorization: Bearer <BLITZCRANK_MCP_TOKEN>`; compared in constant time;
  anything else is `401`.
- Logging: one line per tool call with the tool, the resource or action, `ok`
  or `error`, and the duration. Arguments are never logged.
- Shutdown: `SIGINT` and `SIGTERM` close the listener. An apply still writing
  finishes and records its outcome before the process ends.
- Implementation: `@modelcontextprotocol/sdk` low-level `Server` with
  `ListToolsRequestSchema` and `CallToolRequestSchema` handlers, so tool
  schemas are TypeBox JSON Schema (validated with `typebox/value`), not zod.
  `zod` is installed only because the SDK requires it as a peer.
- Service HTTP goes through the package's own `jsonRequestEffect`
  (`src/http.ts`, copied from the host, plus a `jsonOnly` option that refuses
  a non-JSON response before reading its body). API keys never appear in tool
  output; SABnzbd query keys are redacted.
- Time budget: the host gives one tool call 180 s. A read or plan answers
  within 150 s. An apply spends at most 45 s re-reading, the write's own
  timeout (30 s, 60 s for a grab, 90 s for a Jellyfin rematch), and 30 s
  verifying.

## Environment

| Variable                           | Required | Meaning                                                                |
| ---------------------------------- | -------- | ---------------------------------------------------------------------- |
| `BLITZCRANK_MCP_TOKEN`             | yes      | Bearer token the host presents.                                        |
| `BLITZCRANK_MCP_HOST`              | no       | Bind address, default `127.0.0.1`.                                     |
| `BLITZCRANK_MCP_PORT`              | no       | Listen port, default `8485`.                                           |
| `BLITZCRANK_MCP_PLAN_TTL_MS`       | no       | Plan lifetime, default `1800000` (30 minutes).                         |
| `SEERR_URL`, `SEERR_API_KEY`       | no       | Enables `seerr_*`.                                                     |
| `SONARR_URL`, `SONARR_API_KEY`     | no       | Enables `sonarr_*`.                                                    |
| `RADARR_URL`, `RADARR_API_KEY`     | no       | Enables `radarr_*`.                                                    |
| `SABNZBD_URL`, `SABNZBD_API_KEY`   | no       | Enables `sabnzbd_*`.                                                   |
| `JELLYFIN_URL`, `JELLYFIN_API_KEY` | no       | Enables `jellyfin_*`.                                                  |
| `BLITZCRANK_MEDIA_ROOTS`           | no       | Colon-separated absolute roots; enables `media_probe`, `media_frames`. |

A service whose pair is incomplete is not registered. Starting with no service
and no media roots is an error, as is an empty token, a service URL that is
not `http(s)`, or a media root that is relative or `/`.

## Tool surface

Every configured service gets three tools. Names are stable; the host filters
`sonarr_*` to TV issues and `radarr_*` to movie issues by prefix.

| Tool              | Annotations                                                            | Host exposure         |
| ----------------- | ---------------------------------------------------------------------- | --------------------- |
| `<service>_read`  | `readOnlyHint: true`, `openWorldHint: false`                           | codemode scripts only |
| `<service>_plan`  | `readOnlyHint: true`, `openWorldHint: false`                           | codemode scripts only |
| `<service>_apply` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` | direct Durable tool   |
| `media_probe`     | `readOnlyHint: true`                                                   | codemode scripts only |
| `media_frames`    | `readOnlyHint: true`                                                   | codemode scripts only |

The host decides exposure from `readOnlyHint` alone, so a new read-only tool
needs no host change.

### Input schemas

Every input schema is `type: "object"` at the top level with a discriminator
property (`resource` for reads, `action` for plans) and an `anyOf` listing one
closed variant per value (`additionalProperties: false`, `required` naming the
variant's fields). Codemode renders this as a TypeScript union. Parameter
descriptions carry what the model needs; tool descriptions stay short and list
the variants by name. A variant's own description sits on its discriminator
constant, because codemode renders property descriptions only. Codemode
replaces an input type over 16 000 rendered characters with `unknown`; the
largest today is `sonarr_plan` at about 3 600.

Arguments are checked against the named variant. A mismatch is an `isError`
result that names the offending field, such as
`invalid arguments for sonarr_read episodes: seriesId: must be integer`.

### Results

- Success: `content: [{ type: "text", text }]` plus `structuredContent`
  holding the same value as JSON. `text` is the JSON pretty-printed and capped
  at 30 000 characters with a `... [truncated N chars]` marker;
  `structuredContent` is never truncated. Codemode scripts receive
  `structuredContent`.
- A list is always an object: `{ total, listed, items }`, with
  `truncated: true` when `listed` is short of `total`. Lists cap at 100
  entries. `offset` (or the service's own paging params) reaches the rest.
- `<service>_apply` returns
  `{ planId, action, result, verification?, verificationError?, replayed? }`.
  Its `text` block is what the model reads, so an oversized `result` or
  `verification` is cut on its own and the other parts stay whole.
- `media_frames` returns text and `image` content blocks and no
  `structuredContent`.
- Domain failures (unknown ID, service HTTP error, stale plan, path outside
  roots, invalid arguments) return `isError: true` with one text block.
  Protocol errors are only for malformed requests and unknown tool names.
- Service responses are compacted before they leave the server: the fields the
  agent needs, not raw Arr JSON. Lists are paged or capped and say so.

### Plan and apply

Writes are two calls. `_plan` performs the reads a change depends on, resolves
every target against live state, and returns the concrete effect set. `_apply`
executes exactly that plan.

`<service>_plan` result:

```json
{
  "planId": "sonarr:3f9c...",
  "service": "sonarr",
  "action": "search",
  "summary": "SeasonSearch for series 483 season 2: 24 monitored episodes, 12 already have files and may be replaced",
  "effects": [
    {
      "kind": "search",
      "target": "series 483 season 2",
      "detail": "24 episodes, 12 with files"
    }
  ],
  "warnings": ["3 episodes are unaired"],
  "expiresAt": "2026-10-11T12:34:56.000Z"
}
```

Rules:

- A plan whose target does not exist fails; a hallucinated ID never produces
  a plan. So does a plan that would change nothing, such as monitoring that is
  already set or a search with no episode in scope.
- Each plan records a fingerprint of the state it read (the fields that decide
  the effect set). The fingerprint is computed from the same read the effect
  set came from. `_apply` runs that read again first; a changed fingerprint
  fails with `plan is stale: <field>: <before> -> <after>` and discards the
  plan. A target that is gone at apply is stale too.
- When the re-read fails because the service is unreachable or times out,
  nothing was written, the apply fails saying so, and the plan stays usable.
- `_apply({ planId })` runs the write from the state it just re-read, then the
  verification read-back, and returns
  `{ planId, action, result, verification, verificationError? }`. Verification
  failures never hide a completed write.
- A plan is consumed by its first apply. A second apply with the same
  `planId` returns the recorded outcome with `replayed: true` and runs
  nothing. This is why `_apply` is `idempotentHint: true`. Two applies of one
  plan at the same time share one write: the second waits for the first.
- A write that fails also consumes its plan. The failure is recorded and
  replayed, because a write that timed out or lost its connection may have
  taken effect. The message says whether the service rejected the write or
  its result is unknown.
- An apply does not stop when its client disconnects. Once a write may have
  been sent it runs to the end and records the outcome.
- Plans live in memory with a TTL; a restart forgets them and the model
  re-plans. An apply for another service's plan is an error.
- `_plan` is itself read-only and therefore callable from scripts, so a script
  can compute several plans and the model applies the ones it wants.

## Reads

Every `raw` resource takes a service-relative `path` with its query string. It
must resolve below the service's API prefix on the service itself, so a host,
`..`, or another API is rejected. The response comes back as `{ response }`,
uncompacted, and must be JSON. Secret-named fields (`apiKey`, `password`,
`token`, and the `{ name, value }` pairs Arr settings use) and the service's
own key are masked.

`seerr_read` resources:

| resource  | params                       | returns                                                                           |
| --------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `issue`   | `issueId`                    | issue with comments, media identity, reporter                                     |
| `request` | `requestId`                  | request with status, seasons, requester                                           |
| `search`  | `query`                      | movie and TV matches with `mediaType`, `tmdbId`, `tvdbId` when known, title, year |
| `user`    | `userId`                     | user with permission names and request limits                                     |
| `quota`   | `userId`                     | movie/TV quota                                                                    |
| `raw`     | `path` (GET under `/api/v1`) | `{ response }`                                                                    |

Seerr status codes come back with a `statusLabel` next to the number. Email
addresses are left out.

`sonarr_read` resources (paths under `/api/v3`):

| resource                 | params                                                                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `series`                 | exactly one of `tvdbId` or `seriesId`; one record with seasons and statistics. An untracked `tvdbId` is a failure                                                                                                                                               |
| `lookup`                 | `term`; lookup results, proves no tracking. A tracked hit carries `trackedSeriesId`                                                                                                                                                                             |
| `episodes`               | `seriesId`, optional `seasonNumber`, `offset`; includes file summary per episode                                                                                                                                                                                |
| `episodeFiles`           | `seriesId`, optional `offset`                                                                                                                                                                                                                                   |
| `queue`                  | optional `seriesId`, `offset`; without `seriesId` the whole queue including unknown items                                                                                                                                                                       |
| `history`                | optional `seriesId`, `eventType`, `page`, `pageSize` (max 100, default 50). `eventType` is the name records carry: `grabbed`, `seriesFolderImported`, `downloadFolderImported`, `downloadFailed`, `episodeFileDeleted`, `episodeFileRenamed`, `downloadIgnored` |
| `blocklist`              | optional `seriesId`, `offset`; scans the newest 5 000 entries                                                                                                                                                                                                   |
| `qualityProfiles`        | none                                                                                                                                                                                                                                                            |
| `calendar`               | `start`, `end` ISO dates; unmonitored episodes included                                                                                                                                                                                                         |
| `releases`               | `episodeId` or `seriesId`+`seasonNumber`; filters `publishedAfter`, `titleContains`, `approvedOnly`, `limit`; the compacted listing with counts from today's `sonarr_releases`                                                                                  |
| `manualImportCandidates` | `folder` and/or `downloadId`; each candidate keeps its whole `quality` and `languages`, which a manual import sends back                                                                                                                                        |
| `command`                | `commandId`                                                                                                                                                                                                                                                     |
| `raw`                    | `path` (GET under `/api/v3`)                                                                                                                                                                                                                                    |

`radarr_read`: `movie` (`tmdbId` or `movieId`), `lookup`, `movieFiles`
(`movieId`), `queue`, `history`, `blocklist`, `qualityProfiles`, `calendar`,
`releases` (`movieId` + filters), `manualImportCandidates`, `command`, `raw`.
Same shapes as Sonarr with `movieId` in place of `seriesId`. Its history
`eventType` names are `grabbed`, `downloadFolderImported`, `downloadFailed`,
`movieFileDeleted`, `movieFolderImported`, `movieFileRenamed`,
`downloadIgnored`.

Neither Arr reads a queue item, history record, or blocklist entry by id, so
the server finds them by reading the list. A history record is looked up in
its series' or movie's history when that id is given, and otherwise among the
newest 5 000 records.

`sabnzbd_read`: `queue` (`limit` up to 100 and default 20, `start`, `search`,
`category`, `nzoIds`), `history` (same plus `failedOnly`), `version`,
`warnings`, `serverStats`, `categories`. The server adds `apikey` and
`output=json`. There is no `raw`: a SABnzbd mode can write.

`jellyfin_read`: `search` (`term`, optional `includeItemTypes`), `items`
(`ids`, default fields `MediaSources,Path,ProviderIds`, optional extra
`fields`), `children` (`parentId`, optional `startIndex`), `byProviderId`
(`provider`, `id`, `itemType`), `libraries`, `users`, `sessions`, `userItem`
(`userId`, `itemId`), `remoteSearch` (`itemType`, `itemId` and/or
`searchInfo`; a POST that changes nothing; with only `itemId` it searches by
the item's name and year), `raw` (GET, any path that answers JSON).

`media_probe({ path })`: the ffprobe summary (audio/subtitle languages,
streams, duration) for a file or the largest media file under a release
directory. `media_frames({ path, timestampsSeconds })`: up to six JPEG
frames. Both resolve the path with `realpath` before checking it lies inside
a configured root, require the roots to be configured, and reject symlinks
that leave them. `media_frames` requires a regular file and whitelists
ffmpeg protocols and formats.

## Writes

Every action lists its params, the effect set a plan reports, the
fingerprint apply re-checks, and the verification read-back.

`sonarr_plan` actions:

| action                 | params                                                                                                                                                                                   | plan effects / fingerprint                                                                                                                                                                                            | apply + verify                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `search`               | `seriesId`, optional `seasonNumber` or `episodeIds` (not both)                                                                                                                           | monitored episodes in scope, how many have files; named `episodeIds` are searched even when unmonitored; unaired count as warning; fp = command + scoped episode ids with hasFile and monitored                       | `POST /command` (`SeriesSearch`/`SeasonSearch`/`EpisodeSearch`); verify `GET /command/{id}` |
| `setSeriesMonitoring`  | `seriesId`, optional `monitored`, `seasons[]`, `monitorNewItems`                                                                                                                         | field-level diff; fp = current monitoring fields + preserved fields                                                                                                                                                   | read-modify-write `PUT /series/{id}` keeping every other field; verify read-back diff       |
| `setEpisodeMonitoring` | `episodeIds[]` (max 100), `monitored`                                                                                                                                                    | episodes whose flag changes; fp = current flags                                                                                                                                                                       | `PUT /episode/monitor`; verify episodes read                                                |
| `deleteEpisodeFile`    | `episodeFileId`                                                                                                                                                                          | path, size, episodes covered; fp = file id + path + size + covered episode ids                                                                                                                                        | `DELETE /episodefile/{id}`; verify 404                                                      |
| `removeQueueItem`      | `queueId`, `removeFromClient`, `blocklist`                                                                                                                                               | title, downloadId, status; other queue items sharing the download as warning; fp = queue item present with same downloadId and title                                                                                  | `DELETE /queue/{id}?...`; verify queue read                                                 |
| `markHistoryFailed`    | `historyId`, optional `seriesId`                                                                                                                                                         | release title, downloadId, whether an active grab (warning), whether the record is the grab (warning); fp = history record + whether its download is in the queue                                                     | `POST /history/failed/{id}`; verify blocklist read                                          |
| `deleteBlocklistEntry` | `blocklistId`                                                                                                                                                                            | entry title; fp = entry present                                                                                                                                                                                       | `DELETE /blocklist/{id}`; verify list                                                       |
| `grabRelease`          | `guid`, `indexerId`                                                                                                                                                                      | release identity and the indexer's name; a missing indexer fails the plan; fp = none (the Arr validates the guid against its release cache)                                                                           | `POST /release`; verify queue read                                                          |
| `manualImport`         | `files[]` (`path`, `folderName`, `seriesId`, `episodeIds`, `quality`, `languages`, `releaseGroup`, `downloadId`), `importMode` (`auto`, `move`, `copy`), optional `folder`, `downloadId` | candidates re-read (by `folder`/`downloadId`, else each file's own folder) and matched by path; a path that is not a candidate fails; series and episode ids resolved; rejections become warnings; fp = candidate set | `POST /command` `ManualImport`; verify command                                              |
| `command`              | `name` in `RefreshSeries`, `RescanSeries`, `DownloadedEpisodesScan`, `RefreshMonitoredDownloads`; `seriesId` for the first two, `path` for the scan                                      | target existence; a scan plans over the folder's import candidates and fails when there are none; fp = series id + path, or the candidate set                                                                         | `POST /command`; verify command                                                             |

`radarr_plan` actions: `search` (`movieId`; fp = monitored, hasFile, file id,
availability), `setMovieMonitoring` (`movieId`, `monitored`),
`deleteMovieFile` (`movieFileId`), `removeQueueItem`, `markHistoryFailed`
(optional `movieId`), `deleteBlocklistEntry`, `grabRelease`, `manualImport`
(`files[]` with `movieId`), `command` (`RefreshMovie`, `RescanMovie`,
`DownloadedMoviesScan`, `RefreshMonitoredDownloads`). Same shapes as Sonarr.

`sabnzbd_plan` actions (all take `nzoId`): `retry` (a `Failed` history job),
`pause`, `resume` (a `Paused` queue job), `setPriority` (`priority` in `low`,
`normal`, `high`, `force`), `changeCategory` (`category`, which must exist),
`deleteJob` (`from` in `queue`/`history`, `deleteFiles`). Plan effects name
the job title, category, status, and storage path; fp = job present in the
named list with the same status. Verify re-reads that list and says whether
it shows the expected state.

`jellyfin_plan` actions: `refreshItem` (`itemId`, optional
`metadataRefreshMode` and `imageRefreshMode`, both `Default` when omitted,
`replaceAllMetadata`, `replaceAllImages`; sent recursive),
`applyRemoteSearch` (`itemId`, `searchResult` as returned by the
`remoteSearch` read, `replaceAllImages`, default true). Effects name the
item, type, path, and for a rematch the provider ids before and after; fp =
item exists with same type and path. Verify re-reads the item.

`seerr_plan` actions: `createRequest` (`mediaType`, `mediaId` TMDB id,
optional `seasons[]`, optional `userId`; a TV request without `seasons` asks
for every season), `retryRequest` (`requestId`). The media, the named seasons,
and the user must exist. Effects: title, media type, seasons, existing
requests for the same media as warnings; fp = existing request set and media
status, or for a retry the request's status and seasons. Verify reads the
request back. Comments and issue status are never exposed; the host owns them.

## Layout

```
src/
  cli.ts          entry: config, server, HTTP listener, shutdown
  config.ts       env parsing
  http.ts         jsonRequestEffect and errors
  server.ts       MCP Server, auth, tools/list and tools/call dispatch
  tools.ts        defineRead / definePlanApply helpers, result shaping, caps
  plans.ts        plan store: create, lookup, consume, TTL, fingerprints
  json.ts         JSON narrowing and the field picker compaction uses
  services/
    seerr.ts sonarr.ts radarr.ts arr-common.ts sabnzbd.ts jellyfin.ts
  media/
    probe.ts frames.ts exec.ts paths.ts
```
