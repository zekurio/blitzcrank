# blitzcrank

An agentic webhook gateway for a private media homelab. Jellyseerr issues start
durable investigations across Seerr, Sonarr, Radarr, SABnzbd, and Jellyfin.
The agent applies fixes through typed tools; the host posts comments, resolves
issues, and schedules revisits.

Built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
as an SDK dependency. Blitzcrank does not package or launch the Pi app.

## Deploy on NixOS

Add `github:zekurio/blitzcrank` as a flake input, then:

```nix
{
  imports = [ inputs.blitzcrank.nixosModules.default ];
  services.blitzcrank = {
    enable = true;
    model = "openai/gpt-6-astra:medium"; # choose a model your account can use
    environmentFile = "/run/secrets/blitzcrank.env";
    settings.SEERR_BOT_USERNAME = "blitzcrank";
  };
}
```

Put service URLs, API keys, and `BLITZCRANK_WEBHOOK_SECRET` in that environment
file. `SEERR_URL` and `SEERR_API_KEY` are required.
[`.env.example`](.env.example) documents all settings.

The module installs one command, `blitzcrank`. For subscription authentication:

```sh
sudo blitzcrank auth login openai
sudo blitzcrank auth status
```

On NixOS, auth commands run as the service user with its configured environment
and credential path. The launcher temporarily stops the service and restores its
previous running or stopped state afterward. Run it in an interactive terminal,
including over SSH.

State lives in `/var/lib/blitzcrank`. Back it up with the service stopped, or use
SQLite-aware backups including committed WAL data. Only one service process may
own this directory.

## Authentication and models

API keys use provider environment variables such as `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`; no login command is needed. OAuth uses the main CLI:

```sh
blitzcrank auth login openai
blitzcrank auth status
blitzcrank auth logout openai
```

`openai` supports **Sign in with ChatGPT** through Pi 1.0. Follow the browser
URL, then complete the callback or paste the final redirect URL into the
terminal. `openai-codex` is the legacy provider, not the new subscription flow.
Other OAuth-capable providers use the same `auth login <provider>` command.
Auth commands do not need service credentials or a model selection.

Credentials default to `<BLITZCRANK_DATA_DIR>/auth.json`, or `data/auth.json`
locally. Set `BLITZCRANK_AUTH_PATH` to override this. Keep the file writable:
the SDK refreshes and saves OAuth tokens. The adjacent `.device-id` file holds
a stable installation UUID for login. No ambient Pi auth or models config is
loaded; custom providers require an explicit `BLITZCRANK_MODELS_PATH`.

On NixOS, `services.blitzcrank.authSeedFile` can seed credentials from a secret.
It copies the seed only when missing or changed, preserving refreshed tokens
across ordinary rebuilds.

**Choose a model explicitly.** `BLITZCRANK_MODEL` is required and has no default.
Use `provider/model[:thinking]`, for example `openai/gpt-6-astra:medium`.

Existing deployments that relied on `~/.pi/agent/auth.json` must set an explicit
path or log in again. To move from legacy Codex auth, log in to `openai` and
select an `openai/…` model; do not rename credential entries.

## Develop locally

The standalone [devenv](https://devenv.sh) environment supplies Node, pnpm 11,
ffmpeg, and ffprobe. The flake remains responsible for deployment packages.

```sh
devenv shell
pnpm install --frozen-lockfile
cp .env.example .env
# Fill in service credentials and BLITZCRANK_MODEL.
pnpm exec tsx --env-file=.env src/cli.ts auth login openai
pnpm exec tsx watch --env-file=.env src/cli.ts
```

Skip login if using an API key. Nothing automatically activates the shell or
loads `.env`. `pnpm dev`, `pnpm start`, and `pnpm auth` use the caller's exported
environment. With exported configuration, `pnpm auth login openai` is the local
shortcut. Auth and service commands must use the same data directory/auth path.

Without devenv, supply Node >= 24, pnpm 11, and ffmpeg/ffprobe yourself.
For compiled local runs, use `pnpm build` followed by
`node --env-file=.env dist/cli.js`.

## Connect Jellyseerr

Under **Settings → Notifications → Webhook**, set:

- URL: `http://<blitzcrank-host>:8484/webhook/seerr`
- Authorization: the value of `BLITZCRANK_WEBHOOK_SECRET`
- Payload: the default template
- Notifications: Issue events

Set `SEERR_BOT_USER_ID` and `SEERR_BOT_USERNAME` for the bot's Seerr identity.
Only the reporter or a Seerr user with `ADMIN`/`MANAGE_ISSUES` may drive an issue
through comments. `/blitzcrank stop` pauses its work; `/blitzcrank resume`
allows new events without replaying stopped work or undoing changes.

## Optional features

- **Media inspection:** `BLITZCRANK_MEDIA_ROOTS` permits read-only ffprobe
  inspection of service-supplied paths. Frame extraction also needs ffmpeg
  and an image-capable model.
- **Web:** `BLITZCRANK_WEB_PROVIDER=firecrawl` plus `FIRECRAWL_API_KEY` enables
  read-only search/extraction through hosted Firecrawl. Off by default.

HTTP also exposes an unauthenticated `GET /healthz`.

## Safety and checks

Raw service requests are GET-only. Typed mutations require previously read
target IDs, a reason, and meaningful verification. Web pages, frames, and
issue history cannot authorize changes. Ambiguous interrupted writes
fail closed for review; inspect the service state and logs rather than reset
the job journal to force a retry.

```sh
devenv shell -- pnpm verify
devenv shell -- pnpm build
nix flake check
```

[AGENTS.md](AGENTS.md) records the safety invariants and contribution rules.
[`skills/`](skills) contains service-specific knowledge.

[MIT](LICENSE)
