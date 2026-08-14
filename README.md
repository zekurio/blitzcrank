# blitzcrank

Agentic webhook gateway for a Seerr/Arr/Jellyfin homelab, built on the
[pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

Users report media issues in Jellyseerr ("episode is corrupt", "wrong
language", "won't play"). Jellyseerr fires a webhook at blitzcrank, which opens
an agent session that investigates across your services, fixes what it safely
can, and reports back as a comment on the issue. Scheduled automations run the
same tool layer against recurring homelab chores.

```
Jellyseerr issue ──webhook──▶ blitzcrank host ──▶ pi agent session (one per issue)
                              │    │                │  skills/    domain knowledge
                              │    │                │  reads      *_request (GET-only)
                              │    │                │  mutations  typed tools, evidence
                              │    │                │             gated + verified
                              │    ◀─ directives ──┘  RESOLVE_ISSUE / REVISIT_IN
                              ├── posts comments, resolves issues (host-owned)
                              └── schedules revisits (10m–48h, capped, backed off)
```

This project targets one private deployment. Expect sharp edges.

### Safety model

The host owns every user-visible action; the agent only investigates, mutates
through a narrow typed surface, and returns directives.

- **Host-owned lifecycle** — the agent never comments or resolves directly. It
  emits `RESOLVE_ISSUE: yes|no` plus optional `REVISIT_IN`/`REVISIT_REASON`,
  and the host executes it. Malformed directives ⇒ nothing is posted.
- **GET-only raw tools** — `seerr|sonarr|radarr|jellyfin|sabnzbd_request` can
  only read; SABnzbd reads are limited to `queue`/`history`.
- **Typed mutations** — every state change is its own tool (`sonarr_search`,
  `sonarr_delete_episode_file`, `sabnzbd_retry_job`, …): no raw POST/DELETE
  surface, no path parsing, a mandatory `reason`, and a verification read-back
  returned in the result.
- **Evidence gates** — mutation targets must have appeared in a read earlier in
  the same issue; guessed IDs are rejected in code, not in the prompt.
- **Scope gates** — a multi-episode Sonarr search must state the true episode
  count, and replacing two or more existing files requires that one was
  inspected with `media_probe` this run.
- **No mutation quotas** — issue runs are uncapped, deletions included: one
  number cannot fit both a wrong subtitle track and a season imported as the
  wrong show, and for deletions a cap creates the bad outcome it claims to
  prevent. Everything is still counted, reported, and recorded in the case file.
- **Continuous sessions** — an issue's runs share one agent session, so a
  follow-up comment continues the conversation with its evidence intact, while
  the system prompt and tool list are always rebuilt from the current registry.
- **Comment authorization** — only the issue's reporter or a Seerr user with
  `ADMIN`/`MANAGE_ISSUES` can start a run by commenting; the check fails closed
  when Seerr is unreachable.
- **Loop guards** — the bot's own comment webhooks and `ISSUE_RESOLVED` events
  are dropped, one run leaves at most one comment, and new user activity
  cancels pending revisits.
- **Bounded follow-ups** — at most 3 self-scheduled revisits between two user
  messages, doubling delays when a revisit produced no news. Pending revisits
  are persisted and re-armed after a restart.
- **Read-only extras** — `media_probe` (ffprobe) answers language questions
  from the file rather than the release name, confined to
  `BLITZCRANK_MEDIA_ROOTS` after `realpath`; subscription-backed Codex
  `codex_search` is issue-run-only and never justifies a mutation.
- **Discord is inbound-inert** — reports are posted by the host, never by an
  agent tool, and the bot declares no gateway intents, so no Discord text ever
  reaches a model.

Details and rationale live in [AGENTS.md](AGENTS.md); the legacy Go deployment
this is distilled from is described in `docs/research/legacy.md`.

### Deployment

NixOS is the intended deployment path. Add blitzcrank to your flake inputs:

```nix
inputs.blitzcrank.url = "github:zekurio/blitzcrank";
```

Then import and configure the module:

```nix
{
  imports = [ inputs.blitzcrank.nixosModules.default ];

  services.blitzcrank = {
    enable = true;
    model = "openai-codex/gpt-5.2-codex";
    automationModel = "anthropic/claude-sonnet-4-5:medium"; # optional default
    automationModels = {
      stale-import-handler = "openai-codex/gpt-5.6-terra:high";
    };
    environmentFile = "/run/secrets/blitzcrank.env"; # SEERR_*, SONARR_*, ...
    authSeedFile = "/run/secrets/pi_auth_json";      # optional, OAuth providers
    settings.SEERR_BOT_USERNAME = "blitzcrank";
  };
}
```

State lives in `/var/lib/blitzcrank` (case files, session transcripts, Discord
thread ids, and `auth.json` for OAuth providers — it must stay writable because
tokens refresh in place). To authenticate interactively on the deployed host,
run:

```bash
sudo blitzcrank-login
```

At the pi prompt, enter `/login`, then select the provider (for example, OpenAI
Codex). The helper stops `blitzcrank.service` while pi owns the auth file and
restores its previous running or stopped state when pi exits or the helper is
interrupted. It requires an interactive terminal and works over SSH. The
bundled pi CLI is also exposed as `blitzcrank-pi`; use the helper for login so
it runs with the service's dynamic identity and writable state directory.

As a declarative alternative, `authSeedFile` loads a read-only secret as a
systemd credential and copies it to `authFile` only when the file is missing or
the secret changed, so rebuilds never clobber refreshed tokens; it is a restore
seed, not a live mirror. The interactive helper writes the default
`/var/lib/blitzcrank/auth.json`; use `authSeedFile` when `authFile` is
customized. Automations default to the definitions shipped in the package; set
`automationsDir` to manage your own.

The server exposes `POST /webhook/seerr`, `GET /healthz`, `GET /automations`,
and `POST /automations/:name/run` on `BLITZCRANK_PORT` (default `8484`). All
but `/healthz` require the `BLITZCRANK_WEBHOOK_SECRET` as the `Authorization`
header when one is set.

### Configuration

Everything is environment variables; [`.env.example`](.env.example) documents
each one. `SEERR_URL`/`SEERR_API_KEY` are required. Sonarr, Radarr, SABnzbd,
Jellyfin, media probing, and Discord are optional — their tools are
registered only when configured.

`BLITZCRANK_MODEL` selects the issue-run model as
`provider/model[:thinking]` (default
`anthropic/claude-sonnet-4-5:medium`). `BLITZCRANK_AUTOMATION_MODEL` selects the
default for automation runs and inherits `BLITZCRANK_MODEL` when unset.
`BLITZCRANK_AUTOMATION_MODELS` is a JSON object of per-automation overrides,
for example
`{"stale-import-handler":"openai-codex/gpt-5.6-terra:high"}`. The Nix module
exposes the same mapping as `services.blitzcrank.automationModels`.
Authentication follows pi's resolution order: API-key providers read the usual
env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), OAuth/subscription
providers read a pi `auth.json`. On NixOS, bootstrap the default auth path with
`sudo blitzcrank-login` → `/login`; outside NixOS, bootstrap once with pi and
point `BLITZCRANK_AUTH_PATH` at the writable file (default
`~/.pi/agent/auth.json`). Custom providers can be declared in a `models.json`
via `BLITZCRANK_MODELS_PATH`. Issue runs always include `codex_search`. It uses
the `openai-codex` OAuth credential from that same auth file. The Nix module
uses `gpt-5.6-luna` with high search context by default. Outside NixOS, the
`PI_CODEX_WEB_SEARCH_MODEL` and `PI_CODEX_WEB_SEARCH_CONTEXT_SIZE` variables
set those values.

Every public comment carries a footer with the model identity and the issue's
cumulative token usage, e.g.
`[blitzcrank w/ gpt-5.2-codex:high · 118.2k in · 14.2k out]`. With API-key
authentication it also shows the cumulative API-price estimate, for example
`· $0.42`. For a legacy issue without cumulative cost history, it shows the current
run's estimate instead. Cost is omitted for OAuth subscription authentication,
where a list-price dollar figure would be fiction.

### Jellyseerr webhook

Settings → Notifications → Webhook:

- URL: `http://<blitzcrank-host>:8484/webhook/seerr`
- Authorization header: the value of `BLITZCRANK_WEBHOOK_SECRET`, if set
- Payload: keep the default JSON template
- Notification types: enable the Issue events

Set `SEERR_BOT_USERNAME` (and `SEERR_BOT_USER_ID` for the comment identity) so
the bot's own comments never trigger runs.

### Automations

`automations/*.md` are operator-authored tasks: frontmatter declares the cron
schedule, the capabilities that map to mutation tools, and optional
`mutation_budget`/`deletion_budget`; the body is the trusted instruction text.
Model selection is deployment configuration: a named entry in
`BLITZCRANK_AUTOMATION_MODELS` wins, then `BLITZCRANK_AUTOMATION_MODEL`, then
`BLITZCRANK_MODEL`. For example, an automation definition contains no model:

```yaml
---
name: stale-import-handler
schedule: "0 */3 * * *"
capabilities:
  - sonarr.queue_rejection_cleanup
---
```

A model mapping changes only that automation's fresh agent turn; it does not
expand its service access, capabilities, budgets, or evidence gates. Unknown
automation names and unavailable models are startup errors, so renamed tasks
cannot leave dead routing configuration behind. Runs are triggered by cron,
`POST /automations/:name/run`, or Discord, and one automation never runs twice
concurrently (a busy name is refused with `409`). Every run finishes through
the typed `submit_automation_report` tool. Its validated `status` and `body`
arguments are the authoritative report; the host does not parse a status line
from free-text model output.

Discord monitoring is optional and off unless `DISCORD_BOT_TOKEN` is set (then
`DISCORD_GUILD_ID` and `DISCORD_WATCH_CHANNEL_ID` are required). Each run posts
its formatted report — including "nothing to do" runs, as a heartbeat — into a
private `automation: <name>` thread in the watch channel. The structured status
becomes the report header, and internal history markers are removed before
delivery. `/automation list`
shows schedules and next runs, `/automation run name:<x>` queues one.

Invite the bot with the `bot` and `applications.commands` scopes and grant it
View Channel, Send Messages, Send Messages in Threads, Create Private Threads,
Manage Threads, and Read Message History in that channel (the last is how
archived report threads are found again). Keep the channel admin-only;
blitzcrank never edits permissions itself. Optionally set
`DISCORD_ADMIN_ROLE_IDS` to let non-administrator roles trigger runs. Don't
lock a report thread by hand — reviving it would need Manage Threads on the
thread itself; delete it instead and the next run makes a new one. On startup
blitzcrank purges its application's global commands and bulk-overwrites the
guild command set, so don't share the application with another bot.

### Development

The Nix flake ships a dev shell with Node 24, pnpm, and TypeScript:

```bash
nix develop          # or: direnv allow
pnpm install
cp .env.example .env # fill in service URLs + API keys
pnpm dev             # tsx watch
```

Without Nix: install Node >= 22.19.0 and pnpm, then the same steps. `pnpm
build && pnpm start` compiles to `dist/` and runs it.

Run `pnpm verify` (format check, lint, typecheck, and the tool-surface check)
before opening a pull request. [AGENTS.md](AGENTS.md) covers the safety
invariants, branch/commit conventions, and code style; `skills/` and
`docs/research/` hold the domain knowledge the agent and the code depend on.

### Contributing

Found a bug or have an idea?
[Open an issue](https://github.com/zekurio/blitzcrank/issues/new). Changes that
touch the tool surface, evidence gates, budgets, session resumption, or the
directive protocol must say so explicitly in the pull request.

### License

[MIT](LICENSE)
