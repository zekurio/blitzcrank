# Tools

A run gets two kinds of tools. Host tools are defined in `packages/host` and
can be called straight away. Server tools come from the MCP server's tool list
and start unloaded. The agent loads the ones it needs with `tool_search`,
which keeps their schemas out of the prompt until then.

Every run gets every server tool the server lists. Which tools exist depends
only on how the server is configured.

## Host tools

| Tool                    | What it does                                                       |
| ----------------------- | ------------------------------------------------------------------ |
| `tool_search`           | Loads server tools by exact name or keyword                        |
| `thread_history_search` | Searches text from other threads blitzcrank handled, as leads only |
| `web_search`            | Searches the web through Firecrawl, when [enabled](#web-search)    |
| `web_extract`           | Reads a web page through Firecrawl, when enabled                   |

The agent has no `bash`, `edit`, or `write`.

## Server tools

There is one tool per service read or write, such as `sonarr_episodes` or
`radarr_grab_release`. A service's tools appear only when the server has both
its URL and its API key. The [service tables](../packages/mcp/src/services)
define them, and the [skills](../packages/host/skills) tell the agent how to
use each service.

Every write resolves its target against live state, writes, and reads the
result back. The [server README](../packages/mcp/README.md#writes) covers the
details, and [Write review](write-review.md) covers which writes need the
gate model's approval.

## Media inspection

`media_probe` runs ffprobe on a file, read-only, to check its real audio and
subtitle tracks. `media_frames` pulls frames with ffmpeg so the agent can look
at them. Both are server tools and only read paths inside the configured
media roots.

To turn them on, set `BLITZCRANK_MEDIA_ROOTS` on the server, or
`services.blitzcrank-mcp.mediaRoots` on NixOS. See
[Deploy](deploy.md#media-roots). Give the paths as the server sees them. The
server resolves every path with `realpath` before checking that it's inside a
root, and never reads from the network.

`media_frames` needs ffmpeg on the server and an agent model that takes image
input.

## Web search

Web search is off by default and runs on the host. To turn it on, set
`BLITZCRANK_WEB_PROVIDER=firecrawl` and put `FIRECRAWL_API_KEY` in the host's
environment file. On NixOS, set `services.blitzcrank.webProvider =
"firecrawl"`. Both tools are read-only.

`FIRECRAWL_URL` points the tools at another Firecrawl-compatible endpoint,
such as a fake one for tests.

Firecrawl fetches pages itself, so blitzcrank can't check which address a
fetch reaches. With the hosted API that's Firecrawl's problem. With a
self-hosted instance inside your network, a URL in any chat message could
reach your internal services. Don't run one there.
