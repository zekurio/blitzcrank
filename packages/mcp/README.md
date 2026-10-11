# @blitzcrank/mcp

The Blitzcrank MCP server. It holds the service credentials and media mounts
and exposes typed reads and verified writes for Seerr, Sonarr, Radarr,
SABnzbd, and Jellyfin over the Model Context Protocol (Streamable HTTP). The
host (`packages/host`) connects to it at the start of every issue run and
registers every tool it lists.

## Process

- Binary: `blitzcrank-mcp` (`dist/cli.js`). No arguments.
- Connect using MCP Streamable HTTP at `/mcp`. Use `/healthz` for health checks.
- Configure clients with `Authorization: Bearer <BLITZCRANK_MCP_TOKEN>`.
- Logging: one line per tool call with the tool, `ok`, `error`, or `unknown`,
  and the duration. Arguments are never logged. `unknown` is a write that went
  out and got no answer; the host stops that run for review.
- Stop with `SIGINT` or `SIGTERM` and let active calls finish before restarting.

## Environment

| Variable                           | Required | Meaning                                                                |
| ---------------------------------- | -------- | ---------------------------------------------------------------------- |
| `BLITZCRANK_MCP_TOKEN`             | yes      | Bearer token the host presents.                                        |
| `BLITZCRANK_MCP_HOST`              | no       | Bind address, default `127.0.0.1`.                                     |
| `BLITZCRANK_MCP_PORT`              | no       | Listen port, default `8485`.                                           |
| `SEERR_URL`, `SEERR_API_KEY`       | no       | Enables `seerr_*`.                                                     |
| `SONARR_URL`, `SONARR_API_KEY`     | no       | Enables `sonarr_*`.                                                    |
| `RADARR_URL`, `RADARR_API_KEY`     | no       | Enables `radarr_*`.                                                    |
| `SABNZBD_URL`, `SABNZBD_API_KEY`   | no       | Enables `sabnzbd_*`.                                                   |
| `JELLYFIN_URL`, `JELLYFIN_API_KEY` | no       | Enables `jellyfin_*`.                                                  |
| `BLITZCRANK_MEDIA_ROOTS`           | no       | Colon-separated absolute roots; enables `media_probe`, `media_frames`. |

A service whose pair is incomplete is not registered. Starting with no service
and no media roots is an error, as is an empty token, a service URL that is
not `http(s)`, or a media root that is relative or `/`.

## Source

- [Service tables](src/services)
- [Tool helpers](src/tools.ts)
- [Host adapter](../host/src/mcp/tools.ts)

## Layout

```
src/
  cli.ts          entry: config, server, HTTP listener, shutdown
  config.ts       env parsing
  http.ts         jsonRequestEffect and errors
  server.ts       MCP Server, auth, tools/list and tools/call dispatch
  tools.ts        defineReads / defineWrites helpers, result shaping, caps
  json.ts         JSON narrowing and the field picker compaction uses
  services/
    seerr.ts sonarr.ts radarr.ts arr-common.ts sabnzbd.ts jellyfin.ts
  media/
    probe.ts frames.ts exec.ts paths.ts
```
