# Blitzcrank

Blitzcrank connects Seerr webhooks and scheduled media-server automations to a Pi agent.

Pi owns the agent runtime, provider/auth setup, skills, model selection, durable agent sessions, tool loop, and project-local TypeScript tools. Blitzcrank owns webhook handling, Seerr issue state, final Seerr comments/resolution, and passing configured service credentials to Pi runs.

## Current Scope

- Seerr issue webhooks
- Markdown scheduled automations
- Optional Discord automation reporting and `/automatisierung` trigger command
- Pi RPC runner with persistent sessions
- Typed Pi service request tools for Seerr, Jellyfin, Sonarr, Radarr, SABnzBD, and Anvil systemd status
- SQLite gateway state for Seerr issue dedupe/runs
- Pi session search for prior issue context

Blitzcrank intentionally keeps only a lean Discord automation integration; Pi owns provider integrations, skills, and tool execution.

## Development

```sh
cp config.example.toml blitzcrank.toml
go run ./cmd/blitzcrank
```

Useful checks:

```sh
go test ./...
go build ./cmd/blitzcrank
nix build
```

Logging uses Go `slog` with colored console output by default:

```sh
LOG_LEVEL=debug   # debug|info|warn|error
NO_COLOR=1        # disable ANSI colors
```

## Required Setup

### Pi provider/auth

Configure providers in Pi, not Blitzcrank. For example, use Pi's normal settings/auth flow or provider environment variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. Blitzcrank only passes the configured model string to Pi.

For service deployments, set `[pi].agent_dir` / `PI_CODING_AGENT_DIR` to a writable Pi config directory and seed it with Pi's `auth.json`/`settings.json`, or run Pi login as the same service user. For Codex OAuth with GPT-5.5, use the provider string that `pi --list-models gpt-5.5` reports, for example `openai-codex/gpt-5.5:medium`.

### Blitzcrank secrets

Keep secrets in `.env`, a systemd `EnvironmentFile`, SOPS/agenix, or another secret manager:

```sh
DISCORD_TOKEN=... # optional, for automation reporting/triggering
DISCORD_AUTOMATION_CHANNEL_ID=...
SEERR_API_KEY=...
JELLYFIN_API_KEY=...
SONARR_API_KEY=...
RADARR_API_KEY=...
SABNZBD_API_KEY=...
ANVIL_SYSTEMD_UNIT=anvil.service # optional; defaults to anvil.service
KAGI_API_KEY=... # optional, enables web_search/web_fetch Pi tools
# Optional incoming webhook secret:
SEERR_WEBHOOK_SECRET=...
```

Blitzcrank passes configured service environment to the spawned Pi process so the project-local Pi tools can call Seerr/Jellyfin/Sonarr/Radarr/SABnzBD directly.

## Configuration

Minimal TOML shape:

```toml
[bot]
# Public display name used in startup and status logs.
public_name = "blitzcrank"

[discord]
# Optional automation reporting and /automatisierung command.
guild_id = ""
automation_channel_id = ""
automation_thread_lock = true

[web]
listen_addr = "127.0.0.1:8080"

[seerr]
base_url = "https://seerr.example"
webhook_path = "/webhooks/seerr"
bot_display_name = "Blitzcrank"

[pi]
command = "pi"
cwd = "."
# Optional; set to a seeded Pi config/auth dir for service deployments.
agent_dir = "/var/lib/blitzcrank/pi-agent"
sessions_dir = "pi-sessions"

[pi.models]
# Pi thinking is configured inline with the model, e.g. ":high".
default = "anthropic/claude-sonnet-4-5:high"
seerr = ""
automation = ""

[jellyfin]
base_url = "https://jellyfin.example"

[sonarr]
base_url = "https://sonarr.example"

[radarr]
base_url = "https://radarr.example"

[sabnzbd]
base_url = "https://sabnzbd.example"

[anvil]
systemd_unit = "anvil.service"

[runtime]
automations_dir = "automations"
automations_enabled = false
timezone = "UTC"
run_timeout = "5m"

[storage]
database_path = "./blitzcrank.sqlite"
```

## Pi Resources

Project-local Pi resources live in `.pi/`:

- `.pi/system-prompts/`: first-class Pi agent contracts for Seerr issue runs and scheduled automations.
- `.pi/skills/`: Pi-discoverable service/domain cookbooks for Seerr, Jellyfin, Sonarr, Radarr, SABnzBD, Anvil, and filesystem limitations.
- `.pi/extensions/blitzcrank-tools.ts`: registers direct TypeScript tools for media services, Pi session history, and Kagi web search/fetch.

Pi-visible tools:

- `seerr_request`
- `jellyfin_request`
- `sonarr_request`
- `radarr_request`
- `sabnzbd_request`
- `anvil_status`
- `thread_history_search`
- `web_search`
- `web_fetch`

All service request tools and `anvil_status` require a `purpose`. Paths must be service-relative and must not contain full URLs or credentials. Non-GET requests require `safety_level = "narrow_mutation"` and `safety_reason`. Non-GET requests must additionally match a per-service allowlist enforced in `.pi/extensions/blitzcrank-tools.ts`, covering only the narrow mutations documented in `.pi/skills/`; SABnzbd is read-only. `anvil_status` reads only the configured systemd unit and cannot control services.

## Runtime Flow

1. Seerr sends a webhook to Blitzcrank.
2. Blitzcrank deduplicates and locks the issue.
3. Blitzcrank sends Pi the Seerr issue system prompt plus one task prompt.
4. Pi loads service skills and calls tools through `.pi/extensions/blitzcrank-tools.ts`.
5. The extension calls configured services directly with environment passed to the Pi process.
6. Pi returns a final response beginning with `RESOLVE_ISSUE: yes/no`.
7. Blitzcrank posts the final Seerr comment and resolves the issue only when requested.

## Automations

Markdown automations live in `automations/*.md` and use front matter:

```md
---
name: hourly-stale-import-handler
description: Example automation
schedule: "@hourly"
---

Automation task body...
```

Enable them with:

```toml
[runtime]
automations_enabled = true
automations_dir = "automations"
```

`schedule` accepts standard 5-field cron expressions (`*/15 * * * *`), descriptors (`@hourly`, `@daily`, `@weekly`, ...), and `@every` intervals (`@every 30m`), evaluated in the timezone configured via `runtime.timezone`. Invalid schedules are skipped at startup with a log line rather than dropped silently. Automation runs use the automation system prompt plus the markdown task body, and are invoked without a durable Pi session; each run should treat live service state as the source of truth.

When `DISCORD_TOKEN` and `discord.automation_channel_id` are configured, each automation has a Discord thread titled `automation: {automation name}`. Blitzcrank keeps one transient bot report in that thread, editing it for each run so it reflects the current outstanding automation state, and locks the thread by default. The `/automatisierung` slash command can trigger one of the currently loaded automations manually.

## State

- SQLite gateway state: `storage.database_path`
  - `issue_threads`
  - `issue_thread_events`
  - `issue_runs`
- Pi sessions: `pi.sessions_dir` for non-automation issue runs and history search
Pi owns agent conversation history for issue runs. Automation runs are stateless at the Pi session layer. SQLite is only for Blitzcrank gateway state.

## Nix / NixOS

Build:

```sh
nix build
```

The Nix package includes `automations/` and `.pi/`. Do not put secrets in Nix-store-generated config. Use `services.blitzcrank.environmentFile` or a secret manager for service API keys.

Keep secrets out of commits; `.env*`, local TOML, SQLite files, and Pi session data are ignored.
