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
- **Scope gates** — a Sonarr search touching more than one episode must state the true
  episode count (checked against Sonarr), and replacing two or more existing episode files
  requires that one of them was inspected with `media_probe` this run. A season-wide
  re-grab can no longer ride on release-name metadata.
- **No laundered negatives** — an empty `anvil_job_lookup` is returned as
  `conclusion: UNKNOWN` with the reasons a correct-looking lookup misses, and Anvil output
  paths (`ANVIL_DESTINATION_ROOTS`) are rejected outright instead of silently matching
  nothing. `anvil_job_list` gives the one broad read that can establish absence.
- **Budgets** — max 5 mutations / 2 deletions per run.
- **Built-in verification** — mutation tools perform the follow-up read themselves and
  return it in the result.
- **Loop guards** — the bot's own comment webhooks and `ISSUE_RESOLVED` events are
  dropped; new user activity cancels pending revisits.
- **Comment authorization** — follow-up comments only start a run when their author is
  the issue's reporter or a Seerr user with `ADMIN`/`MANAGE_ISSUES`. Identity is matched
  by email whenever both sides have one, the check runs before the revisit cancellation,
  and it fails closed if Seerr can't be consulted.
- **Media probe** — optional read-only `media_probe` (ffprobe) when
  `BLITZCRANK_MEDIA_ROOTS` is set: the real audio/subtitle streams of a file or release
  directory, before or after import. Arr `languages` is parsed from the release name
  (`MULTi` is a claim, not a fact), so language questions are answered from the file.
  Paths are resolved through `realpath` and must land inside a configured root.
- **Web tools** — optional Firecrawl `web_search`/`web_fetch` (issue runs only,
  when `FIRECRAWL_API_KEY` is set; `FIRECRAWL_API_URL` for self-hosted) for availability/context answers; fetch rejects
  local/private URLs and web content never justifies a mutation.

## Layout

- `src/server.ts` — Hono webhook endpoint (`POST /webhook/seerr`), `GET /healthz`, `GET /automations`, `POST /automations/:name/run`, event filtering
- `src/queue.ts` / `src/revisits.ts` — serial run queue + revisit scheduler
- `src/agent/` — pi SDK session factory, issue system prompt, directive parsing
- `src/automations/` — automation definitions (frontmatter + trusted body), capability→tool mapping, cron scheduling, `STATUS:` report protocol
- `automations/` — operator-authored scheduled tasks (e.g. the hourly stale-import handler)
- `src/tools/` — run context (evidence/budgets), GET-only read tools, typed mutation tools, anvil, media probe
- `src/services/` — HTTP helper + host-side Seerr client (comments, status)
- `src/webhook/` — Seerr payload types + comment authorization gate
- `skills/` — agent skills for Sonarr, Radarr, SABnzbd, Jellyfin, Seerr, Anvil, media-probe, filesystem
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

`BLITZCRANK_MODEL` is `provider/model[:thinking]` (default
`anthropic/claude-sonnet-4-5:medium`). Every public comment carries a footer
with the model identity and the run's total token usage and cost, e.g.
`[blitzcrank w/ gpt-5.2-codex:high · 48.2k tokens · $0.19]`.
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
    authSeedFile = "/run/secrets/pi_auth_json";      # optional, see below
    settings.SEERR_BOT_USERNAME = "blitzcrank";
  };
}
```

State lives in `/var/lib/blitzcrank` (session transcripts, and `auth.json`
for OAuth providers — drop the bootstrapped file there, it stays writable).
`authSeedFile` automates that bootstrap: the secret is loaded as a systemd
credential and copied to `authFile` when that file is missing or when the
secret changed, so refreshed OAuth tokens are never clobbered by a rebuild.
It is a restore seed, not a live mirror — rotating refresh tokens make the
encrypted copy stale after first use.
Automations default to the definitions shipped in the package; set
`services.blitzcrank.automationsDir` to manage your own.

### Who may talk to the agent

Only the issue's reporter and Seerr users with the `ADMIN` or `MANAGE_ISSUES`
permission can drive a run by commenting. Everyone else's comments are
acknowledged with `200` and ignored (no run, no revisit cancellation). Set
`SEERR_BOT_USERNAME` so the bot's own comments never trigger runs either.

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
- broader test suite (only the comment gate is covered; directives/context/safety/automations
  parsing are pure and easy to cover)
- NixOS module + package output in the flake (systemd timers may own automation scheduling)
