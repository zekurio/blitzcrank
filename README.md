# Blitzcrank

Blitzcrank is a Go Discord bot and AI support agent for Jellyseerr, Jellyfin, Sonarr, Radarr, SABnzbd, and related media-server operations.

It provides:

- a Discord gateway listener for one configured support channel
- a Jellyseerr webhook endpoint for issue workflows
- workflow-scoped prompt and skill loading from Markdown
- OpenAI-compatible chat completions, first-class OpenRouter support, and optional Codex subscription OAuth support
- service tools for Jellyseerr, Jellyfin, Sonarr, Radarr, SABnzbd, read-only filesystem diagnostics, and optional Exa web search
- scheduled Markdown automations, including narrowly scoped repair handlers

## Configuration

Copy `.env.example` to `.env` for local development and fill in the values you need.

Required for Jellyseerr issue handling:

- `SEERR_BASE_URL`
- `SEERR_API_KEY`
- one LLM provider credential, usually `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or Codex OAuth credentials, plus a runtime profile provider

Set `SEERR_WEBHOOK_LISTEN_ADDR`, for example to `127.0.0.1:8080`, to enable the local Jellyseerr webhook endpoint. The webhook is disabled by default; when it is enabled, strict startup validation requires both `SEERR_BASE_URL` and `SEERR_API_KEY`.

Required for Discord support:

- `DISCORD_TOKEN`
- `DISCORD_CHANNEL_ID`

Optional but recommended for requester-aware Seerr requests from Discord:

- Seerr user profiles should have their `discordId` / `Discord Benutzer ID` field populated
- `DISCORD_SEERR_USER_MAP` may be used as an override/fallback JSON object mapping Discord user ids to Seerr user ids

The Discord application must have the Message Content intent enabled for normal channel-message triage.

For OpenRouter usage:

```env
OPENROUTER_API_KEY=...
AGENT_DEFAULT_PROVIDER=openrouter
AGENT_DEFAULT_MODEL=openai/gpt-5.5
OPENROUTER_HTTP_REFERER=https://your-domain.example
OPENROUTER_X_TITLE=Blitzcrank
```

For Codex subscription OAuth:

```env
AGENT_DEFAULT_PROVIDER=codex-oauth
AGENT_DEFAULT_MODEL=gpt-5.5
CODEX_AUTH_PROFILE=default
CODEX_FAST_MODE=false
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

This endpoint is only served when `SEERR_WEBHOOK_LISTEN_ADDR` is set, for example:

```env
SEERR_WEBHOOK_LISTEN_ADDR=127.0.0.1:8080
```

If `SEERR_WEBHOOK_SECRET` is set, Jellyseerr must send either:

- `Authorization: Bearer <secret>`
- `X-Blitzcrank-Webhook-Secret: <secret>`

## Workflows

Jellyseerr issue webhooks are allowed to use mutating repair tools when the issue context and tool evidence justify it. New and reopened issues start a solver run, user comments append to the stored thread and rerun the solver, and resolved events complete the thread.

Discord support runs may use scoped write tools. New acquisition requests should go through Jellyseerr/Seerr request tools when a Discord user maps to a Seerr user, so quotas and permissions are checked before downstream services are mutated. Scheduled automations are read-only by default; a narrowly scoped automation may use mutating tools only when its prompt explicitly authorizes the exact action, such as importing a verified stale Sonarr/Radarr download.

Final Jellyseerr comments are signed by the harness with `[blitzcrank w/ <model>]`. The agent should return only the final German comment body.

## State

Blitzcrank stores queryable runtime state in SQLite at `DATABASE_PATH`:

- issue threads
- Discord agent threads
- webhook and Discord events
- issue solver runs
- Discord automation thread mappings

It also writes append-only JSONL traces under `AGENT_THREADS_DIR`:

- `issues/issue-<id>.jsonl`
- `discord/<thread-id>.jsonl`
- `discord/interactions/<message-id>.jsonl`
- `automations/<name>.jsonl`

Skill and automation Markdown files are runtime inputs. The Nix package installs the repository defaults under `share/blitzcrank/skills` and `share/blitzcrank/automations`; source-tree runs default to `skills/` and `automations/`. Prompts are built into the binary and are not runtime-customizable.

## Markdown Inputs

Prompts live in `prompts/*.md` and are embedded at build time.

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
name: hourly-stale-import-handler
description: Hourly Sonarr/Radarr handler for stale completed downloads that are safe to manually import.
schedule: "@hourly"
---

Run the hourly stale import handler...
```

Use a robfig/cron descriptor such as `@hourly` or a five-field cron expression prefixed with `cron:`.

Set `SKILLS_DIR` and `AUTOMATIONS_DIR` to runtime-managed directories. Skills follow the `skills.sh` style: each skill is a directory containing `SKILL.md`, and the frontmatter `name` must match the directory name.

Discord also exposes skill-specific slash commands that bypass natural-language capability detection:

- `/jellyfin prompt:...`
- `/jellyseerr prompt:...`
- `/sonarr prompt:...`
- `/radarr prompt:...`
- `/sabnzbd prompt:...`
- `/filesystem prompt:...`

These commands select the matching skill/tool group explicitly. Follow-up messages continue the same interaction only when the user replies directly to a Blitzcrank bot message; unrelated later channel messages are ignored by that completed interaction.

Automations load from `AUTOMATIONS_DIR`. Set `AUTOMATIONS_EXTRA_DIRS` to a comma-separated list of directories with additional `.md` automation definitions. The scheduler reloads automation definitions while running, so added or edited automation files are picked up without restarting the service.

## Runtime Profiles

The default LLM runtime comes from the `AGENT_DEFAULT_*` profile. Override individual workflows with:

- `AGENT_SEERR_*` for Jellyseerr issue solving and review
- `AGENT_DISCORD_*` for Discord mention and thread answers
- `AGENT_AUTOMATION_*` for scheduled automations
- `AGENT_DISCORD_TRIAGE_*` for Discord triage and thread summaries

Each profile accepts `PROVIDER`, `MODEL`, and `REASONING_EFFORT`. Provider values are `openai-compatible`, `openrouter`, or `codex-oauth`. Provider credentials are loaded independently from provider-specific env vars, and profiles choose which configured provider to use.

Runtime-manageable config is stored in JSON at `RUNTIME_CONFIG_PATH` (default `./runtime-config.json`; the NixOS module defaults to `/var/lib/blitzcrank/runtime-config.json`). When `RUNTIME_CONFIG_PATH` is set and the file does not exist, Blitzcrank seeds it from the effective env/Nix defaults for model profiles, `SKILLS_DIR`, `AUTOMATIONS_DIR`, `AUTOMATIONS_ENABLED`, and `TIMEZONE`. After that, the JSON file overrides env/Nix defaults. Packaged deployments can also set `RUNTIME_DEFAULT_CONFIG_PATH` to a read-only JSON defaults file; mutable runtime config is applied after that file. The legacy `CRON_ENABLED` env var and `cron_enabled` runtime key are still accepted for existing deployments.

CLI examples:

```sh
blitzcrank config keys
blitzcrank config get runtime.automation.model
blitzcrank config set runtime.automation.model anthropic/claude-sonnet-4.6
blitzcrank config set automations_enabled true
```

Discord exposes `/automation name:<automation>` as an admin-only command to run an automation directly with autocomplete. Runtime configuration is not mutable through Discord.

## Nix

The flake packages the Go binary plus reloadable skill and automation defaults in `$out/share/blitzcrank`. The packaged binary defaults `SKILLS_DIR` and `AUTOMATIONS_DIR` to those installed directories, so `nix run` and `result/bin/blitzcrank` do not depend on source-tree Markdown paths.

Build the package:

```sh
nix build
```

The flake also exports `nixosModules.default`, which defines `services.blitzcrank`. The module creates a system user, stores mutable state in `/var/lib/blitzcrank`, uses the embedded Markdown defaults, writes Nix-managed runtime defaults as JSON, and accepts an `environmentFile` for secrets and service credentials.

The Nix-managed runtime JSON is read-only and acts as a defaults layer. Changes made through the CLI are written to `/var/lib/blitzcrank/runtime-config.json`, so runtime edits survive restarts and override the Nix defaults without being clobbered by rebuilds.

Example:

```nix
services.blitzcrank = {
  enable = true;
  environmentFile = config.sops.secrets.blitzcrank_env.path;
  automations.enable = true;
  runtime.automation = {
    provider = "openrouter";
    model = "anthropic/claude-sonnet-4.6";
  };
  runtime.seerr = {
    provider = "codex-oauth";
    model = "gpt-5.5";
    reasoningEffort = "high";
  };
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
