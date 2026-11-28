# @blitzcrank/mcp

The blitzcrank MCP server. It holds the service credentials and media mounts,
and gives the agent typed reads and verified writes for Matinee, Sonarr,
Radarr, and SABnzbd over MCP Streamable HTTP. The host in `packages/host`
connects at the start of every run and registers every tool the server lists.

The server needs no agent host on the same machine. To deploy it on NixOS,
see [Deploy](../../docs/deploy.md).

## Process

The command is `blitzcrank-mcp`, built to `dist/cli.js`. It takes no
arguments.

- MCP clients connect at `/mcp` and send
  `Authorization: Bearer <BLITZCRANK_MCP_TOKEN>`.
- `/healthz` answers health checks without a token.
- Stop it with `SIGINT` or `SIGTERM`. Active calls finish before it exits.

The server logs one JSON record when a tool call starts and one when it
completes, with the tool, the duration, and an outcome of `ok`, `error`, or
`unknown`. It never logs arguments or result bodies. The host sends
`X-Blitzcrank-Run-Id` and `X-Blitzcrank-Thread` so records line up with its
own. Other clients can leave them out.

`ok` means the call returned. It doesn't mean a queued operation finished or
that its check passed. `unknown` means a write went out and no answer came
back. The host stops that run for review.

## Writes

Each write is one call. It resolves its target against live state, writes,
and reads the result back. A service rejection comes back as an error result.
A write whose outcome never came back is a JSON-RPC error. A client
disconnect never cuts a write off before its read-back.

### Which writes are destructive

Every write sets `readOnlyHint: false`. A write that removes nothing and
overrides no choice someone made also sets `destructiveHint: false`. The host
has its gate model [review](../../docs/write-review.md) every other write
before it runs.

These writes are not destructive:

- Sonarr and Radarr refreshes and rescans
- retrying, pausing, resuming, or reprioritizing a SABnzbd job
- `matinee_scan_library`, which queues the same full scan of one library that
  Matinee's timed scan runs

Everything else is destructive. Two cases are less obvious. A search is
destructive, because a search over a season, a series, or items that already
have files can replace them. `matinee_refresh_title` is destructive, because
a provider ID in the folder name wins over a match an admin fixed by hand,
and a title with no match can be reset to its folder name.

In a `defineWrites` table, an action is destructive unless it sets
`destructive: false`.

### Previews

`write_preview` runs only the resolve phase of one write. It returns the
`summary`, `effects`, and `warnings` the write would report, and writes
nothing. The host's review reads it.

`*_grab_release` only sends a release that a `*_releases` read on this server
listed in the last hour. Its preview names the release and any full-season
pack. Any other guid fails with nothing written.

### Locks

A whole-record monitoring update holds a lock on that record until its
read-back finishes. A second update to the same record gets a busy error
before the server contacts the service, so read the current state before
retrying. Updates to different records run at the same time.

Locks live inside one server process. They don't cover other writers, or a
write still pending upstream after an `unknown` outcome.

## Environment

| Variable                         | Required | Meaning                                                                    |
| -------------------------------- | -------- | -------------------------------------------------------------------------- |
| `BLITZCRANK_MCP_TOKEN`           | yes      | Bearer token the host presents                                             |
| `BLITZCRANK_MCP_HOST`            | no       | Bind address, default `127.0.0.1`                                          |
| `BLITZCRANK_MCP_PORT`            | no       | Listen port, default `8485`                                                |
| `MATINEE_URL`, `MATINEE_API_KEY` | no       | Turns on `matinee_*`. See [Matinee's token](#matinees-token).              |
| `SONARR_URL`, `SONARR_API_KEY`   | no       | Turns on `sonarr_*`                                                        |
| `RADARR_URL`, `RADARR_API_KEY`   | no       | Turns on `radarr_*`                                                        |
| `SABNZBD_URL`, `SABNZBD_API_KEY` | no       | Turns on `sabnzbd_*`                                                       |
| `BLITZCRANK_MEDIA_ROOTS`         | no       | Colon-separated absolute paths. Turns on `media_probe` and `media_frames`. |

A service with only one of its two settings isn't registered. The server
refuses to start with an empty token, with no service and no media roots,
with a service URL that isn't `http` or `https`, or with a media root that is
relative or `/`.

Media tools resolve every path with `realpath` before checking it's inside a
root. They never read from the network.

### Matinee's token

The server sends `MATINEE_API_KEY` as `Authorization: Bearer <token>` on
every Matinee call. Matinee decides what a call may see and do from both the
token's permissions and its account's, so a call needs each permission from
both. [Connect Matinee](../../docs/matinee.md) walks through making the
token.

The token takes exactly these permissions:

| Permission           | Used by                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `title.read`         | `matinee_search`, `matinee_title`, and the reads before a write               |
| `title.update`       | `matinee_matches`, `matinee_refresh_title`, `matinee_identify_title`          |
| `library.read`       | `matinee_libraries`, and the reads before a write                             |
| `library.scan`       | `matinee_scan_library`                                                        |
| `media.read`         | `matinee_files`, `matinee_tracks`                                             |
| `catalog.read`       | `matinee_by_provider_id`, `matinee_catalog_search`, `matinee_catalog_details` |
| `adminRequest.read`  | `matinee_requests`                                                            |
| `adminRequest.retry` | `matinee_retry_request`                                                       |
| `job.read`           | `matinee_jobs`                                                                |
| `request.create`     | `matinee_ask`                                                                 |

It must not hold `all`, `adminRequest.approve`, `adminRequest.decline`, or
`request.autoApprove`. Without them it approves and declines nothing, and its
own requests wait for approval. The server doesn't check the token's
permissions. When one is missing, Matinee answers 403 with its name, and the
tool reports that as its error.

Every request the agent makes comes from the token's account. Chats share that
account's quota, and Matinee doesn't show who asked. The token never appears
in a tool result or a log line.

Matinee's live sessions, users, and groups have no tool. Every run gets every
read, and those would show who watches what.

## Layout

```
src/
  cli.ts          entry: config, server, HTTP listener, shutdown
  config.ts       env parsing
  http.ts         jsonRequestEffect and errors
  server.ts       MCP Server, auth, tools/list and tools/call dispatch
  json.ts         JSON narrowing and the field picker compaction uses
  tools/
    tool.ts       ServerTool, runTool, read and write deadlines
    reads.ts      resource and defineReads
    writes.ts     action and defineWrites: resolve, write, read back, locks
    preview.ts    write_preview: a write's resolve phase alone
    kept-reads.ts the read cache every write drops
    results.ts    result shaping and caps
    params.ts     argument checks against a table entry's schema
    errors.ts     ToolError, WriteOutcomeUnknown, record reads, failures
  services/
    <service>/
      index.ts    build<Service>Tools: the service's tool list
      client.ts   authenticated requests and the reads they share
      reads.ts    the defineReads table
      writes.ts   the defineWrites table
      ...         compaction and helpers, one concern per module
    arr/          what Sonarr and Radarr share: client, tables, helpers
    matinee/      also links.ts (pasted web links), ask.ts (planning a
                  request), requests.ts (the admin request queue), and
                  folder-ids.ts (provider ids in folder names)
  media/
    probe.ts frames.ts exec.ts paths.ts
```

The host's side of the connection is
[`packages/host/src/mcp/tools.ts`](../host/src/mcp/tools.ts).
