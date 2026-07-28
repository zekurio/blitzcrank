# blitzcrank

Agentic webhook gateway for a Seerr/Arr/Jellyfin homelab, built on the
[pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

Users report media issues in Jellyseerr ("episode is corrupt", "wrong language",
"won't play"). Jellyseerr fires a webhook at blitzcrank, which spins up an agent
session that investigates across your services, fixes what it safely can, and
reports back as a comment on the issue.

```
Jellyseerr issue ──webhook──▶ blitzcrank host ──▶ pi agent session (one per run)
                              │    │                │  skills/   (domain knowledge)
                              │    │                │  reads:    *_request  (GET-only)
                              │    │                │  mutations: typed tools w/ evidence
                              │    │                │             gates + budgets + verify
                              │    ◀─ directives ──┘  RESOLVE_ISSUE / REVISIT_IN/_REASON
                              ├── posts comments, resolves the issue (host-owned)
                              └── schedules revisits (10m–48h)
```

## Safety model

Adapted from the legacy Go deployment (see `docs/research/legacy.md`), tightened
because enforcement now lives in-process:

- **Host-owned lifecycle** — the agent never comments or resolves directly; it returns a
  directive block (`RESOLVE_ISSUE: yes|no`, optional `REVISIT_IN`/`REVISIT_REASON`) and
  the host executes it. Malformed directives ⇒ nothing is posted.
- **GET-only raw tools** — `seerr|sonarr|radarr|jellyfin|sabnzbd_request` can only read;
  SABnzbd raw reads are limited to `queue`/`history`; Seerr lifecycle paths are blocked.
- **Typed mutations** — every state change is its own tool (`sonarr_search`,
  `sonarr_delete_episode_file`, `radarr_delete_movie_file`, `sabnzbd_retry_job`, …).
  No raw POST/DELETE surface, no path parsing. SAB job control (retry/delete/pause/
  resume) and Radarr file deletion extend the legacy allowlist deliberately.
- **Evidence gates** — mutation targets must have appeared in a GET response earlier in
  the same run; guessed IDs are rejected in code.
- **Budgets** — max 5 mutations / 2 deletions per run.
- **Built-in verification** — mutation tools perform the follow-up read themselves and
  return it in the result.
- **Loop guards** — the bot's own comment webhooks and `ISSUE_RESOLVED` events are
  dropped; new user activity cancels pending revisits.
- **Web tools** — optional Firecrawl `web_search`/`web_fetch` (issue runs only,
  when `FIRECRAWL_API_KEY` is set; `FIRECRAWL_API_URL` for self-hosted) for availability/context answers; fetch rejects
  local/private URLs and web content never justifies a mutation.

## Layout

- `src/server.ts` — Hono webhook endpoint (`POST /webhook/seerr`), `GET /healthz`, `GET /automations`, `POST /automations/:name/run`, event filtering
- `src/queue.ts` / `src/revisits.ts` — serial run queue + revisit scheduler
- `src/agent/` — pi SDK session factory, issue system prompt, directive parsing
- `src/automations/` — automation definitions (frontmatter + trusted body), capability→tool mapping, cron scheduling, `STATUS:` report protocol
- `automations/` — operator-authored scheduled tasks (e.g. the hourly stale-import handler)
- `src/tools/` — run context (evidence/budgets), GET-only read tools, typed mutation tools, anvil
- `src/services/` — HTTP helper + host-side Seerr client (comments, status)
- `skills/` — agent skills for Sonarr, Radarr, SABnzbd, Jellyfin, Seerr, Anvil, filesystem
  (merged from the battle-tested legacy deployment)
- `docs/research/` — pi-sdk guide, Seerr/service API references, legacy design reference

## Dev environment

Nix flake devshell (node 24, pnpm, typescript). With direnv: `direnv allow`.
Otherwise: `nix develop`.

```sh
pnpm install
cp .env.example .env   # fill in service URLs + API keys
pnpm dev               # tsx watch
pnpm typecheck
pnpm build && pnpm start
```

## Configuration

All via env (see `.env.example`). `SEERR_URL`/`SEERR_API_KEY` are required;
Sonarr/Radarr/SABnzbd/Jellyfin are optional — their tools are only registered
when configured.

### Models & auth

`BLITZCRANK_MODEL` is `provider/model` (default `anthropic/claude-sonnet-4-5`).
Authentication, in pi's resolution order:

- **API-key providers** (`anthropic/...`, `openai/...`): the usual env vars
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...).
- **OAuth/subscription providers** (`openai-codex/...` via ChatGPT Plus/Pro,
  Claude Pro/Max, ...): a pi `auth.json`. Bootstrap once interactively — run
  `pi`, `/login`, pick the provider — then point `BLITZCRANK_AUTH_PATH` at the
  file (or copy the provider's entry from `~/.pi/agent/auth.json`). The file
  must stay **writable**: tokens auto-refresh and are persisted back. Unset,
  blitzcrank falls back to `~/.pi/agent/auth.json`.
- Custom providers can be declared in a pi `models.json` via
  `BLITZCRANK_MODELS_PATH`.

### NixOS

The flake ships a linux package and a NixOS module:

```nix
{
  imports = [ blitzcrank.nixosModules.default ];
  services.blitzcrank = {
    enable = true;
    model = "openai-codex/gpt-5.2-codex";
    environmentFile = "/run/secrets/blitzcrank.env"; # SEERR_*, SONARR_*, ...
    settings.SEERR_BOT_USERNAME = "blitzcrank";
  };
}
```

State lives in `/var/lib/blitzcrank` (session transcripts, and `auth.json`
for OAuth providers — drop the bootstrapped file there, it stays writable).
Automations default to the definitions shipped in the package; set
`services.blitzcrank.automationsDir` to manage your own.

### Jellyseerr webhook setup

Settings → Notifications → Webhook:

- URL: `http://<blitzcrank-host>:8484/webhook/seerr`
- Authorization header: value of `BLITZCRANK_WEBHOOK_SECRET` (if set)
- Payload: keep the default JSON template
- Notification types: enable the Issue events

## Status / roadmap

Done: scaffolding, webhook intake, host-owned issue lifecycle with directives and
revisits, tightened typed tool layer with evidence gates/budgets/verification, merged
production skills, ManualImport tools, scheduled automations (cron + manual trigger,
capability-scoped tools, per-automation budgets, `STATUS:` protocol), persisted run
transcripts + `thread_history_search`.

Ideas for later (see the porting checklist in `docs/research/legacy.md`):

- optional second-model mutation review for high-risk ops (legacy broker, in-process)
- report sinks beyond the log (ntfy/Discord) and Discord agents
- proper test suite (directives/context/safety/automations parsing are pure and easy to cover)
- NixOS module + package output in the flake (systemd timers may own automation scheduling)
