# Blitzcrank

Blitzcrank connects Seerr webhooks, watched Discord support channels, and scheduled media-server automations to a Pi agent.

Pi owns the agent runtime, provider/auth setup, skills, model selection, durable agent sessions, tool loop, and project-local TypeScript tools. Blitzcrank owns webhook handling, Seerr issue state, final Seerr comments/resolution, and passing configured service credentials to Pi runs.

## Current Scope

- Seerr issue webhooks
- Markdown scheduled automations
- Optional Discord conversational support agent, automation reporting, and `/automatisierung` trigger command
- Pi RPC runner with source-isolated persistent sessions
- Typed Pi service request tools for Seerr, Jellyfin, Sonarr, Radarr, SABnzBD, and Anvil systemd status
- Independent mutation review for every agent-initiated operational non-GET request
- SQLite gateway state for Seerr/Discord dedupe, recovery, and sanitized mutation-review audit metadata
- Pi session search for prior issue context

Pi owns provider integrations, skills, and tool execution. Blitzcrank owns ingress, source authority, privacy boundaries, mutation enforcement, and final delivery.

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
DISCORD_TOKEN=... # optional, for Discord conversations and automation reporting/triggering
DISCORD_GUILD_ID=...
DISCORD_AUTOMATION_CHANNEL_ID=...
DISCORD_WATCHED_CHANNEL_IDS=123456789012345678,234567890123456789
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

### Discord bot setup

The conversational agent processes only channel IDs listed in `discord.watched_channel_ids`. A non-empty list requires `DISCORD_TOKEN` and a non-empty, separately configured `pi.models.discord_triage` model. It ignores DMs, bots, webhooks, system messages, edits, reactions, voice events, and attachment contents. Passive messages must pass a strict no-tools Pi triage; a direct mention is always considered and receives a concise failure response if triage or the working run cannot proceed.

Enable only the Discord Gateway `Guilds`, `Guild Messages`, and `Message Content` intents. `MESSAGE_CONTENT` is a privileged intent: enable it for the application in the Discord Developer Portal as well as granting it in the bot session. The bot needs these channel permissions in every watched channel and its threads:

- View Channel and Read Message History
- Send Messages and Send Messages in Threads
- Create Private Threads
- Manage Threads, so it can maintain and archive bot-owned support threads
- Use Application Commands, when `/automatisierung` is enabled

Public-safe facts and simple read-only questions reply directly, including title-specific release dates, exact-title Jellyfin availability, and basic Jellyfin/Sonarr/Radarr reachability. Direct runs are sessionless, deterministically read-only, and limited to narrowly scoped service reads; they must not expose users, viewing activity, paths, configuration, queues, history, downloads, or unrelated library contents. User-specific data, operational detail, mutations, diagnostics, and genuine multi-turn investigations move to a non-invitable private thread. Blitzcrank adds only the triggering user, keeps one owner per conversation, suppresses generated mentions, and archives the thread after 24 hours of inactivity by default. Discord members with Manage Threads remain an unavoidable moderator-level exception to thread privacy. If private-thread creation fails, Blitzcrank never falls back to publishing sensitive results in the public channel.

## Configuration

Minimal TOML shape:

```toml
[bot]
# Public display name used in startup and status logs.
public_name = "blitzcrank"

[discord]
# Optional conversational agent plus automation reporting and /automatisierung.
guild_id = ""
automation_channel_id = ""
automation_thread_lock = true
# Only new human messages in these public guild channels are eligible.
watched_channel_ids = ["123456789012345678"]
triage_timeout = "8s"
debounce = "750ms"
thread_inactivity = "24h"
retention = "720h"
mutation_budget = 3

[web]
listen_addr = "127.0.0.1:8080"

[seerr]
base_url = "https://seerr.example"
webhook_path = "/webhooks/seerr"
bot_display_name = "Blitzcrank"
mutation_budget = 5

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
discord_triage = "provider/fast-model"
discord = ""
# Required because the enabled Discord/Seerr workflows above have non-zero
# mutation budgets. It must be configured explicitly and never inherits default.
review = "provider/review-model:high"

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
review_timeout = "15s"
review_capacity = 1
automation_mutation_budget = 5

[review]
confirmation_ttl = "15m"

[storage]
database_path = "./blitzcrank.sqlite"
```

## Pi Resources

Project-local Pi resources live in `.pi/`:

- `.pi/system-prompts/`: source-specific Pi contracts for Seerr, automations, Discord triage/working runs, and mutation review.
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

All service request tools and `anvil_status` require a `purpose`. Paths must be service-relative and must not contain full URLs or credentials. Non-GET requests require `safety_level = "narrow_mutation"` and `safety_reason`. Non-GET requests must additionally match the fixed per-service allowlist enforced in `.pi/extensions/blitzcrank-tools.ts`; SABnzbd is read-only. `anvil_status` reads only the configured systemd unit and cannot control services.

Every allowed operational non-GET request is then sent through the loopback-only Go review broker before the exact request executes. A separate no-tools, no-session Pi reviewer can approve, deny, or request source-appropriate confirmation. `pi.models.review` must be configured explicitly whenever an enabled Discord, Seerr, or automation workflow has a non-zero mutation budget; it never falls back to `pi.models.default`. Approval is bound to a hash of the exact sanitized proposal plus trusted run/source/actor context; the reviewer cannot override the hard allowlist or lower baseline risk. Reviewer failure or timeout denies the mutation while reads and conversation can continue. Fresh reads must validate successful mutations. Discord, Seerr, and automation runs default to mutation budgets of 3, 5, and 5 respectively.

Application mechanics are outside this operational review boundary: Discord replies/thread operations, Seerr comments/progress, SQLite bookkeeping, automation reports, and revisit scheduling are not reviewed. Bot-proposed Seerr issue resolution is reviewed separately before finalization.

## Runtime Flow

1. Seerr sends a webhook to Blitzcrank.
2. Blitzcrank deduplicates and locks the issue.
3. Blitzcrank sends Pi the Seerr issue system prompt plus one task prompt.
4. Pi loads service skills and calls tools through `.pi/extensions/blitzcrank-tools.ts`.
5. The extension calls configured services directly with environment passed to the Pi process.
6. Pi returns a final response beginning with `RESOLVE_ISSUE: yes/no`.
7. Blitzcrank posts the final Seerr comment and resolves the issue only after finalization review approves and a fresh Seerr read confirms the resolved state.

## Automations

Markdown automations live in `automations/*.md` and use front matter:

```md
---
name: hourly-stale-import-handler
description: Example automation
schedule: "@hourly"
capabilities:
  - sonarr.manual_import
  - radarr.manual_import
mutation_policy: narrow
mutation_budget: 5
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

The mutation fields are enforcement inputs, not hints:

- `capabilities` is the exact allowlist of operational actions the checked-in task definition authorizes. An empty list is read-only.
- `mutation_policy` is `read_only` or `narrow`; `narrow` still requires the deterministic endpoint allowlist and an independent reviewer approval for every exact proposal.
- `mutation_budget` defaults to 5 and may be set from 0 through 10. `runtime.automation_mutation_budget` is an operator-side global ceiling.

Automations cannot interactively confirm a proposal. A reviewer verdict of `needs_confirmation` or `deny`, a review timeout, or a capability mismatch skips the mutation and should be reported for manual review. The bundled stale-import automation declares only Sonarr/Radarr manual import and exact rejection-cleanup capabilities.

When `DISCORD_TOKEN` and `discord.automation_channel_id` are configured, each automation has a Discord thread titled `automation: {automation name}`. Blitzcrank keeps one transient bot report in that thread, editing it for each run so it reflects the current outstanding automation state, and locks the thread by default. The `/automatisierung` slash command can trigger one of the currently loaded automations manually.

## State

- SQLite gateway state: `storage.database_path`
  - `issue_threads`
  - `issue_thread_events`
  - `issue_runs`
  - `discord_conversations`
  - `discord_messages`
  - `discord_runs`
  - `mutation_reviews`
  - `mutation_executions`
  - `mutation_validations`
- Pi sessions: `pi.sessions_dir`, partitioned by source and conversation

After upgrading from an earlier build, Blitzcrank moves legacy root-level `.jsonl` issue sessions into the new `seerr/` namespace before starting any agents. New private Discord sessions live under `discord/`; an existing partitioned target is never overwritten.

SQLite Discord records contain IDs, owner/route/category/status, timing, and sanitized errors only—not private message or response bodies. Mutation-review audit rows contain run/actor/conversation IDs, proposal hash, service/method/capability, fixed risk, verdict/outcome, timing, and sanitized errors; exact paths, bodies, authority text, evidence, reviewer prose, and authorization tokens are not persisted. Discord private-thread sessions are keyed by thread ID and are not exposed through Seerr, automation, another Discord user, or the history-search tool. Direct Discord and automation runs are sessionless.

## Nix / NixOS

`nix build` packages the complete `.pi` directory, including all source-specific prompts and the TypeScript extension. Its check phase also starts Pi offline in RPC mode with the packaged extension explicitly loaded and verifies a successful `get_state` response. This catches TypeScript/import/registration failures without provider credentials or a model call; end-to-end tool execution and reviewer-model behavior still require a configured Pi installation and live integration environment.

Build:

```sh
nix build
```

The Nix package includes `automations/` and `.pi/`. Do not put secrets in Nix-store-generated config. Use `services.blitzcrank.environmentFile` or a secret manager for service API keys.

Keep secrets out of commits; `.env*`, local TOML, SQLite files, and Pi session data are ignored.
