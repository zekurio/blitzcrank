# blitzcrank

An agentic webhook gateway for a private media homelab. Jellyseerr issues start
durable investigations across Seerr, Sonarr, Radarr, SABnzbd, and Jellyfin.

It runs as two processes:

- The host (`packages/host`, command `blitzcrank`) receives the Seerr webhook,
  runs the agent, and posts its final message as the comment. Resolving the
  issue is left to its reporter. The host holds the model credentials and the
  Seerr key it comments with. Seerr is one gateway behind an interface; the
  agent loop only sees threads.
- The MCP server (`packages/mcp`, command `blitzcrank-mcp`) holds the service
  API keys and the media mounts. Every read and write the agent makes goes
  through it, one tool per operation.

The server's [service tables](packages/mcp/src/services) define the available
reads and writes. The agent starts each run with a handful of host tools and
loads the service tools it needs with `tool_search`. The
[server README](packages/mcp/README.md) covers operation.

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
    mcpUrl = "http://127.0.0.1:8485/mcp";
    environmentFile = "/run/secrets/blitzcrank.env";
  };
  services.blitzcrank-mcp = {
    enable = true;
    environmentFile = "/run/secrets/blitzcrank-mcp.env";
    mediaRoots = [ "/mnt/media" "/mnt/downloads/complete" ]; # optional
  };
}
```

The two services are enabled independently and use separate packages:
`packages.<system>.blitzcrank` and `packages.<system>.blitzcrank-mcp`. Each
package contains its own command and runtime dependencies. The default package
is the host. Each service has its own `package` option and environment:

- The host's environment file holds `SEERR_URL`, `SEERR_API_KEY`,
  `BLITZCRANK_WEBHOOK_SECRET`, and `BLITZCRANK_MCP_TOKEN`.
  [`packages/host/.env.example`](packages/host/.env.example) documents all host
  settings.
- The server's environment file holds the service URLs and API keys and the
  same `BLITZCRANK_MCP_TOKEN`. `services.blitzcrank-mcp.mediaRoots` sets the
  media roots and adds ffmpeg to the server's path. The server runs as a
  dynamic user: `services.blitzcrank-mcp.supplementaryGroups` gives it group
  access to roots that are closed to others. The
  [server README](packages/mcp/README.md#environment) documents its settings.

The server binds to `127.0.0.1` on `services.blitzcrank-mcp.port` (8485 by
default). The host requires `services.blitzcrank.mcpUrl`, including when both
run on the same machine. Set it to the server's endpoint if you change the
port. With both enabled on one machine, the host starts after the server and
stops before it.

For separate machines, import `nixosModules.blitzcrank` on the agent host and
`nixosModules.blitzcrank-mcp` on the media server, enabling only the respective
service. Set the host's `mcpUrl` to the remote endpoint. On the media server,
set `services.blitzcrank-mcp.host` to a private interface address, or keep
loopback and put a TLS reverse proxy in front. Configure network access
separately; the module does not open firewall ports. The server needs no model
or agent authentication settings.

[`nix/module.nix`](nix/module.nix) and
[`nix/mcp-module.nix`](nix/mcp-module.nix) describe the service options.

The shared dependency hash in [`nix/package.nix`](nix/package.nix) must
match `pnpm-lock.yaml`. After a lockfile change, build once on Linux and copy
the hash Nix reports.

The module installs the `blitzcrank` command. For subscription authentication:

```sh
sudo blitzcrank auth login openai
sudo blitzcrank auth status
```

On NixOS, auth commands run as the service user with its configured environment
and credential path. The launcher temporarily stops the service and restores its
previous running or stopped state afterward. Run it in an interactive terminal,
including over SSH.

State lives in `/var/lib/blitzcrank`. Back it up with the service stopped, or use
SQLite-aware backups including committed WAL data. Only one host process may
own this directory. The server keeps nothing on disk.

## Authentication and models

API keys use provider environment variables such as `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`; no login command is needed. OAuth uses the main CLI:

```sh
blitzcrank auth login openai
blitzcrank auth status
blitzcrank auth logout openai
```

`openai` supports **Sign in with ChatGPT**. Follow the browser
URL, then complete the callback or paste the final redirect URL into the
terminal.
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

## Develop locally

The standalone [devenv](https://devenv.sh) environment supplies Node, pnpm 11,
ffmpeg, and ffprobe. The flake remains responsible for deployment packages.

The repository is a pnpm workspace. Install once at the root, then run each
package from its own directory with its own `.env`, in two terminals. Start
the server first; the host connects to it at the start of every run.

```sh
# Terminal 1: the MCP server
devenv shell
pnpm install --frozen-lockfile
cd packages/mcp
# Write .env from the Environment table in README.md: BLITZCRANK_MCP_TOKEN
# plus the service URLs and API keys.
pnpm exec tsx watch --env-file=.env src/cli.ts
```

```sh
# Terminal 2: the host
devenv shell
cd packages/host
cp .env.example .env
# Fill in BLITZCRANK_MODEL, SEERR_URL, SEERR_API_KEY, the same
# BLITZCRANK_MCP_TOKEN, and BLITZCRANK_MCP_URL=http://127.0.0.1:8485/mcp.
pnpm exec tsx --env-file=.env src/cli.ts auth login openai
pnpm exec tsx watch --env-file=.env src/cli.ts
```

Skip login if using an API key. Nothing automatically activates the shell or
loads `.env`. The root scripts `pnpm dev`, `pnpm dev:mcp`, `pnpm start`,
`pnpm start:mcp`, and `pnpm auth` use the caller's exported environment. With
exported configuration, `pnpm auth login openai` is the local shortcut. Auth
and host commands must use the same data directory/auth path.

Without devenv, supply Node >= 24, pnpm 11, and ffmpeg/ffprobe yourself.
For compiled local runs, use `pnpm build` at the root, then
`node --env-file=.env dist/cli.js` in each package.

## Connect Jellyseerr

Under **Settings → Notifications → Webhook**, set:

- URL: `http://<blitzcrank-host>:8484/webhook/seerr`
- Authorization: the value of `BLITZCRANK_WEBHOOK_SECRET`
- Payload: the default template
- Notifications: Issue events

Set `SEERR_BOT_USER_ID` and `SEERR_BOT_USERNAME` for the bot's Seerr identity.
Only the reporter or a Seerr user with `ADMIN`/`MANAGE_ISSUES` may drive an issue
through comments.

## Optional features

- **Media inspection** is configured on the server. `BLITZCRANK_MEDIA_ROOTS`
  in the server's environment permits read-only ffprobe inspection of paths
  inside the roots, as the server sees them. Frame extraction also needs
  ffmpeg on the server and an image-capable model.
- **Web** stays on the host. `BLITZCRANK_WEB_PROVIDER=firecrawl` plus
  `FIRECRAWL_API_KEY` enables read-only search/extraction through hosted
  Firecrawl. Off by default.

Both processes answer an unauthenticated `GET /healthz`.

## Logs and journals

The host writes JSON lifecycle records to stdout/stderr, captured by journald
on NixOS. They include job admission and recovery, queue time, run duration,
model requests and token/cache/reasoning counts, tool starts and outcomes, and
reply publication. Filter by `runId` to follow a run across both processes.
`run.admitted` maps that ID to its `thread`, such as `seerr:21`.

```sh
sudo journalctl -u blitzcrank -u blitzcrank-mcp --since today -o cat
sudo journalctl -u blitzcrank -u blitzcrank-mcp -o cat |
  jq -R 'fromjson? | select(.runId == "RUN_ID")'
```

`tool.completed` with `status: "error"` is a tool result the model can handle.
An MCP `unknown` outcome or a host `review_required` rejection stops a write
for review. `model.completed` records provider attempts, including failures;
these log counts are diagnostic, not the durable usage ledger. The
`threadInputTokens` and `threadOutputTokens` on `run.answer` are conversation
totals, not per-run totals.

Operational records omit arguments, result bodies, prompts, replies, user
identities, and error messages that might contain private data. Full details
remain in the existing SQLite journals under `BLITZCRANK_DATA_DIR`:
`jobs.sqlite` records admission, status, publication intents/results, and
failures; `sessions/<gateway>/<thread>.sqlite` holds the Durable transcript,
tool outcomes, and usage ledger. These files contain private data. Use the run
ID to find the job and its matching Durable submission. No second transcript
or model-writable memory is kept. A completed action replay is logged as
`action.replayed`, not as another publication.

## Checks

```sh
devenv shell -- pnpm verify
devenv shell -- pnpm build
nix flake check
```

[AGENTS.md](AGENTS.md) records the host invariants and contribution rules.
[`packages/host/skills/`](packages/host/skills) contains service-specific
knowledge. The [service tables](packages/mcp/src/services) define the tools.

[MIT](LICENSE)
