# Blitzcrank

Blitzcrank is a Go Discord bot and AI support agent for Jellyseerr, Jellyfin, Sonarr, Radarr, SABnzbd, and related media-server operations.

It provides:

- a Discord gateway listener for one configured support channel
- a Jellyseerr webhook endpoint for issue workflows
- workflow-scoped prompt and skill loading from Markdown
- OpenAI-compatible chat completions, including OpenRouter-compatible headers
- optional Codex subscription OAuth support
- service tools for Jellyseerr, Jellyfin, Sonarr, Radarr, SABnzbd, read-only filesystem diagnostics, and optional Exa web search
- scheduled read-only Markdown automations

## Configuration

Copy `.env.example` to `.env` for local development and fill in the values you need.

Required for Jellyseerr issue handling:

- `SEERR_BASE_URL`
- `SEERR_API_KEY`
- one LLM backend, usually `OPENAI_API_KEY` with `OPENAI_BASE_URL`, or `LLM_PROVIDER=codex-oauth`

Required for Discord support:

- `DISCORD_TOKEN`
- `AGENT_DISCORD_CHANNEL_ID`

The Discord application must have the Message Content intent enabled for normal channel-message triage.

For OpenRouter-compatible usage:

```env
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=...
MODEL=openai/gpt-5.5
OPENROUTER_HTTP_REFERER=https://your-domain.example
OPENROUTER_X_TITLE=Blitzcrank
```

For Codex subscription OAuth:

```env
LLM_PROVIDER=codex-oauth
MODEL=gpt-5.5
CODEX_AUTH_PROFILE=default
CODEX_SERVICE_TIER=standard
```

Then run:

```sh
go run ./cmd/blitzcrank codex login
go run ./cmd/blitzcrank codex status
```

Credentials are stored outside the repo by default at `~/.config/blitzcrank/auth.json`.

## Running Locally

```sh
go run ./cmd/blitzcrank
```

Jellyseerr webhooks should post JSON to:

```text
http://127.0.0.1:8080/webhooks/seerr
```

If `SEERR_WEBHOOK_SECRET` is set, Jellyseerr must send either:

- `Authorization: Bearer <secret>`
- `X-Blitzcrank-Webhook-Secret: <secret>`

## Workflows

Jellyseerr issue webhooks are allowed to use mutating repair tools when the issue context and tool evidence justify it. New and reopened issues start a solver run, user comments append to the stored thread and rerun the solver, and resolved events complete the thread.

Discord support runs and scheduled automations are read-only. They may inspect configured services, filesystem roots, and web search, but they must not trigger searches, refreshes, retries, deletes, or issue resolution.

Final Jellyseerr comments are signed by the harness with `[blitzcrank w/ <model>]`. The agent should return only the final German comment body.

## State

Blitzcrank stores queryable runtime state in SQLite at `DATABASE_PATH`:

- issue threads
- Discord agent threads
- webhook and Discord events
- issue solver runs
- automation run summaries

It also writes append-only JSONL traces under `AGENT_THREADS_DIR`:

- `issues/issue-<id>.jsonl`
- `automations/<name>.jsonl`

Prompt, skill, and automation Markdown files are runtime inputs, not database state.

## Markdown Inputs

Prompts live in `prompts/*.md`.

Skills live in `skills/<name>/SKILL.md` with frontmatter:

```md
---
name: jellyfin
description: Use when diagnosing Jellyfin library availability.
---
```

Skills are loaded at startup and selected per request by workflow and tool group. Jellyseerr issue runs include the issue-solver skill plus relevant service skills. Discord and automation runs get only the skills matching the tools available for that request.

Automations live in `automations/*.md`:

```md
---
name: daily-health-check
description: Check media automation queues and recent failures.
schedule: "cron: 0 9 * * *"
---

Run the daily media automation health check...
```

Use a robfig/cron descriptor such as `@hourly` or a five-field cron expression prefixed with `cron:`.

Markdown inputs are loaded once at startup. Restart the service after editing them.

## Nix

The flake packages the Go binary with immutable Markdown assets installed under:

```text
$out/share/blitzcrank/prompts
$out/share/blitzcrank/skills
$out/share/blitzcrank/automations
```

Build the package:

```sh
nix build
```

The flake also exports `nixosModules.default`, which defines `services.blitzcrank`. The module creates a system user, stores mutable state in `/var/lib/blitzcrank`, points prompt/skill/automation paths at the package assets, and accepts an `environmentFile` for secrets.

Example:

```nix
services.blitzcrank = {
  enable = true;
  environmentFile = config.sops.secrets.blitzcrank_env.path;
};
```

## Development

Run tests:

```sh
go test ./...
```

Build the binary:

```sh
go build ./cmd/blitzcrank
```

Run one focused package test:

```sh
go test ./internal/store -run TestStorePersistsIssueThreadEventAndRun
```
