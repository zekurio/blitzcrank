# @blitzcrank/mcp

The Blitzcrank MCP server. It holds the service credentials and media mounts
and exposes typed reads and verified writes for Matinee, Sonarr, Radarr, and
SABnzbd over the Model Context Protocol (Streamable HTTP). The host
(`packages/host`) connects to it at the start of every run and registers every
tool it lists.

## Process

- Binary: `blitzcrank-mcp` (`dist/cli.js`). No arguments.
- Connect using MCP Streamable HTTP at `/mcp`. Use `/healthz` for health checks.
- Configure clients with `Authorization: Bearer <BLITZCRANK_MCP_TOKEN>`.
- Logging: JSON start and completion records with the tool, `ok`, `error`, or
  `unknown`, and the duration. The host sends `X-Blitzcrank-Run-Id` and
  `X-Blitzcrank-Thread` for correlation; other clients may omit them. Arguments
  and result bodies are never logged. `unknown` is a write that went out and
  got no answer; the host stops that run for review. `ok` means the call
  returned, not that a queued operation finished or its verification passed.
- Stop with `SIGINT` or `SIGTERM` and let active calls finish before restarting.

Whole-record monitoring updates hold a resource lock through their read-back.
A competing update to the same record returns a busy error before contacting
the service; read the current state before retrying. Different records run
concurrently. Locks apply within one MCP process. They do not cover other
writers or writes still pending upstream after an unknown outcome.

Every write is `readOnlyHint: false`. One that removes nothing and overrides
no choice someone made also sets `destructiveHint: false`; every other write is
destructive, and the host has its gate model review each call of one before it
runs. The unreviewed writes are the Arr refreshes and rescans, retrying,
pausing, resuming, or reprioritizing a SABnzbd job, and
`matinee_scan_library`, which queues the same full scan of one library that
Matinee's timed scan runs. `matinee_refresh_title` is reviewed: a provider id
in the folder name wins over a match an admin fixed by hand, and a title
without a match can be reset to its folder name. An action in a
`defineWrites` table is destructive unless it sets `destructive: false`.
A search is destructive: one over a season, a series, or items that have
files can replace them. `write_preview` runs one write's resolve phase alone
and returns the `summary`, `effects`, and `warnings` the write would report,
with nothing written; the host's review reads it. `*_grab_release` sends only
a release a `*_releases` read of this server listed in the last hour, and
names it and any full-season pack in its preview; any other guid fails with
nothing written.

On NixOS, import `nixosModules.blitzcrank-mcp` and enable
`services.blitzcrank-mcp`. It uses the separate `blitzcrank-mcp` flake package
and requires no agent host on that machine. See the
[deployment guide](../../README.md#deploy-on-nixos) for local and remote setups.

## Environment

| Variable                         | Required | Meaning                                                                |
| -------------------------------- | -------- | ---------------------------------------------------------------------- |
| `BLITZCRANK_MCP_TOKEN`           | yes      | Bearer token the host presents.                                        |
| `BLITZCRANK_MCP_HOST`            | no       | Bind address, default `127.0.0.1`.                                     |
| `BLITZCRANK_MCP_PORT`            | no       | Listen port, default `8485`.                                           |
| `MATINEE_URL`, `MATINEE_API_KEY` | no       | Enables `matinee_*` with an admin account's token.                     |
| `MATINEE_REQUEST_API_KEY`        | no       | An ordinary account's token; adds the catalog reads and `matinee_ask`. |
| `SONARR_URL`, `SONARR_API_KEY`   | no       | Enables `sonarr_*`.                                                    |
| `RADARR_URL`, `RADARR_API_KEY`   | no       | Enables `radarr_*`.                                                    |
| `SABNZBD_URL`, `SABNZBD_API_KEY` | no       | Enables `sabnzbd_*`.                                                   |
| `BLITZCRANK_MEDIA_ROOTS`         | no       | Colon-separated absolute roots; enables `media_probe`, `media_frames`. |

A service whose pair is incomplete is not registered. Starting with no service
and no media roots is an error, as is an empty token, a service URL that is
not `http(s)`, or a media root that is relative or `/`.

### Matinee's two tokens

The server sends both tokens as `Authorization: Bearer <token>`. Matinee works out
what a call may see and do from the account the token belongs to.

- `MATINEE_API_KEY` belongs to an admin account. Every Matinee read and the
  repairs go through it: scans, refreshes, matches, and retrying a failed
  request. Without it nothing of Matinee is registered.
- `MATINEE_REQUEST_API_KEY` belongs to an ordinary account. Its Matinee group
  sets what may be requested, whether requests wait for an admin's approval,
  and the quota. Only it makes requests (`matinee_ask`), and it also makes the
  catalog reads that lead to one (`matinee_catalog_search`,
  `matinee_catalog_details`), because Matinee computes destinations, limits,
  and availability from the caller. Without it no tool that requests a title
  is registered. An admin's token there would hand everyone in a chat the
  admin's request policy, and the write review cannot know a person's Matinee
  entitlements, so the limit lives in which account this token belongs to.
  The same token as `MATINEE_API_KEY` is refused at startup.

Give each token only the permissions its calls take, in Matinee under
Settings → Account → API tokens. A token narrows its account, so the account
must hold them too, and a token with `all` is the whole account.

| Token                     | Permissions                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATINEE_API_KEY`         | `title.read`, `title.update`, `library.read`, `library.scan`, `media.read`, `catalog.read`, `adminRequest.read`, `adminRequest.update`, `job.read` |
| `MATINEE_REQUEST_API_KEY` | `catalog.read`, `request.create`, and `request.autoApprove` if the group's members skip approval                                                   |

Matinee answers 403 and names the permission when a token lacks one, and the
tool reports that as its error.

Every request the agent makes is the request account's. Neither token appears
in a tool result or a log line. Matinee's live sessions, users, and groups have
no tool: every run gets every read, and those name who watches what.

## Source

- [Service tables](src/services)
- [Tool helpers](src/tools)
- [Host adapter](../host/src/mcp/tools.ts)

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
