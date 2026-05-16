# Blitzcrank

Blitzcrank is a Discord bot and AI support agent for Jellyseerr/Jellyfin media server operations.

It currently provides:

- A Discord gateway listener for one configured channel.
- A Jellyseerr webhook HTTP endpoint.
- Skill-driven agent behavior from `skills/*/SKILL.md`.
- OpenAI-compatible chat completions, including OpenRouter-compatible headers.
- Tool calls for Jellyseerr issues/requests, Jellyfin item and stream lookup, Sonarr queue/series/file metadata lookup, and Radarr queue/movie/file metadata lookup.

## Configuration

Copy `.env.example` to `.env` and fill in the values you need.

Required for the Seerr issue workflow:

- `OPENAI_API_KEY` or `OPENROUTER_API_KEY`
- `MODEL`
- `SEERR_BASE_URL`
- `SEERR_API_KEY`

Optional for Discord channel chat:

- `DISCORD_TOKEN`
- `AGENT_DISCORD_CHANNEL_ID`

For OpenRouter:

```env
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=...
MODEL=openai/gpt-5.5
REASONING_EFFORT=
OPENROUTER_HTTP_REFERER=https://your-domain.example
OPENROUTER_X_TITLE=Blitzcrank
```

For Codex subscription OAuth:

```env
LLM_PROVIDER=codex-oauth
MODEL=gpt-5.5
REASONING_EFFORT=
CODEX_AUTH_PROFILE=default
CODEX_SERVICE_TIER=standard
```

Then run:

```sh
go run ./cmd/blitzcrank codex login
go run ./cmd/blitzcrank codex status
```

Credentials are stored outside the repo by default at `~/.config/blitzcrank/auth.json`.

Set `CODEX_SERVICE_TIER=fast` only when using `LLM_PROVIDER=codex-oauth` and you want lower-latency runs. Final comments include the tier in the header, for example `[blitzcrank w/ gpt-5.5 fast]`.

Jellyseerr webhooks should post JSON to:

```text
http://127.0.0.1:8080/webhooks/seerr
```

If `SEERR_WEBHOOK_SECRET` is set, Jellyseerr must send either:

- `Authorization: Bearer <secret>`
- `X-Blitzcrank-Webhook-Secret: <secret>`

The Seerr workflow only acts on issue-related webhooks. New and reopened issues start a solver run, user comments append to the internal thread and rerun the solver, and resolved events complete the thread. Bot-authored comments are ignored to avoid loops.

Set `SEERR_BOT_USER_ID` to a dedicated Jellyseerr bot user id if your instance supports API user attribution. Blitzcrank signs final comments as `[blitzcrank w/ <model>]`, followed by a German explanation of the issue and fix.

## Run

```sh
go run ./cmd/blitzcrank
```

The Discord application must have the Message Content intent enabled if you want the bot to respond to normal channel messages.

## State

Blitzcrank stores queryable runtime state in SQLite at `DATABASE_PATH`:

- issue threads
- webhook events
- issue solver runs
- automation run summaries

It also writes append-only JSONL traces under `AGENT_THREADS_DIR`:

- `issues/issue-<id>.jsonl`
- `automations/<name>.jsonl`

Skills and automations remain file-backed Markdown and are not stored in SQLite.

## Agent Skills

Edit the built-in system prompt in `prompts/system.md`. The prompt supports these placeholders:

- `{{bot_name}}`
- `{{current_time}}`

Put behavior and response rules in Codex-style skill files under `skills/<name>/SKILL.md`. Skills are loaded alphabetically and appended to the built-in system prompt as domain-specific instructions for the same agent run.

Agent runs use `MODEL`, defaulting to `gpt-5.5` when unset. If `REASONING_EFFORT` is empty, Blitzcrank uses curated defaults: `gpt-5.4-mini` uses `high`, `gpt-5.4` uses `medium`, and `gpt-5.5` uses `low`. Set `REASONING_EFFORT` to override that globally.

```md
---
name: seerr-issue-solver
description: Main orchestrator for Jellyseerr issue webhooks.
---
```

## Available Tools

- `seerr_get_request`
- `seerr_get_issue`
- `jellyfin_search_items`
- `jellyfin_get_item`
- `jellyfin_get_item_media_info`
- `jellyfin_get_child_media_info`
- `jellyfin_refresh_item`
- `sonarr_get_series_by_tvdb_id`
- `sonarr_get_queue`
- `sonarr_get_blocklist`
- `sonarr_delete_blocklist_item`
- `sonarr_get_episodes_by_series_id`
- `sonarr_get_episode_file`
- `sonarr_get_episode_files_by_series_id`
- `sonarr_search_episode`
- `sonarr_search_season`
- `sonarr_search_series`
- `sonarr_refresh_series`
- `sonarr_retry_queue_item`
- `radarr_get_movie_by_tmdb_id`
- `radarr_get_movie_by_id`
- `radarr_get_movie_file`
- `radarr_get_queue`
- `radarr_get_blocklist`
- `radarr_delete_blocklist_item`
- `radarr_search_movie`
- `radarr_refresh_movie`
- `radarr_retry_queue_item`
- `sabnzbd_get_queue`
- `sabnzbd_get_history`
- `fs_stat_path`
- `fs_list_dir`
- `fs_find_recent`
- `fs_disk_usage`
- `web_search` when `EXA_API_KEY` is configured

Filesystem tools are read-only and require `FS_TOOL_ALLOWED_ROOTS` to be set to comma-separated absolute paths, such as `/downloads,/media`.

## Automations

Set `CRON_ENABLED=true` to run Markdown-defined automations from `AUTOMATIONS_DIR` in `TIMEZONE`.

```env
CRON_ENABLED=true
AUTOMATIONS_DIR=automations
AUTOMATION_TASKS=daily-health-check
```

Each automation is a Markdown file with frontmatter:

```md
---
name: daily-health-check
description: Check media automation queues and recent failures.
schedule: "cron: 0 9 * * *"
---

Run the daily media automation health check...
```

Use a robfig/cron descriptor or a five-field cron expression:

```md
schedule: "cron: */30 * * * *"
```

```md
schedule: "@hourly"
```

`AUTOMATION_TASKS` is an optional comma-separated filter. Leave it empty to run every `*.md` automation in the directory. Results are logged and mirrored to Discord only when the Discord listener is configured.
