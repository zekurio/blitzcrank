# Deploy on NixOS

The flake has one NixOS module per process. `nixosModules.default` imports
both. `nixosModules.blitzcrank` is the host alone and
`nixosModules.blitzcrank-mcp` is the server alone. Each module has its own
package, `packages.<system>.blitzcrank` and `packages.<system>.blitzcrank-mcp`,
and you can override either with the service's `package` option. The default
package is the host.

## One machine

Add `github:zekurio/blitzcrank` as a flake input, then:

```nix
{
  imports = [ inputs.blitzcrank.nixosModules.default ];

  services.blitzcrank = {
    enable = true;
    model = "openai/gpt-6-astra:medium"; # a model your account can use
    helperModel = "openai/gpt-5.4-mini:off"; # small and fast, names threads
    gateModel = "anthropic/claude-haiku-5-5:high"; # reviews destructive writes
    mcpUrl = "http://127.0.0.1:8485/mcp";
    settings = {
      FLUXER_INSTANCE_URL = "https://chat.example.com";
      FLUXER_CHANNELS = "12345678901234567";
      FLUXER_ALLOWED_ROLES = "23456789012345678";
      FLUXER_TRIAGE_MODEL = "opencode/jev-1.13";
    };
    environmentFile = "/run/secrets/blitzcrank.env";
  };

  services.blitzcrank-mcp = {
    enable = true;
    environmentFile = "/run/secrets/blitzcrank-mcp.env";
    mediaRoots = [ "/mnt/media" "/mnt/downloads/complete" ]; # optional
  };
}
```

[Models](models.md) explains the three model options and
[Connect Fluxer](fluxer.md) explains the `FLUXER_*` settings.

The server listens on `127.0.0.1:8485` by default. Change it with
`services.blitzcrank-mcp.port`. The host has no default for `mcpUrl`, so set
it even when both run on the same machine, and update it if you change the
port. With both services on one machine, systemd starts the host after the
server and stops it first.

## Secrets

Each service reads its own environment file.

The host's file holds `FLUXER_BOT_TOKEN`, `BLITZCRANK_MCP_TOKEN`, and any
provider API keys such as `ANTHROPIC_API_KEY`. Add `FIRECRAWL_API_KEY` if you
turn on [web search](tools.md#web-search).
[`packages/host/.env.example`](../packages/host/.env.example) lists every host
setting.

The server's file holds the same `BLITZCRANK_MCP_TOKEN` plus each service's
URL and API key, the [Matinee token](matinee.md) among them. The
[server README](../packages/mcp/README.md#environment) lists every server
setting. Service credentials never go in the host's file.

## Media roots

`services.blitzcrank-mcp.mediaRoots` turns on the read-only
[media tools](tools.md#media-inspection) and adds ffmpeg to the server's path.
Give the paths as the server sees them, usually the library plus the download
client's completed directory. The module adds each root as a mount dependency,
so the server waits for a ZFS pool or network share instead of starting on an
empty mountpoint.

The server runs as a systemd dynamic user. If a root is readable by a group
but closed to others, list that group in
`services.blitzcrank-mcp.supplementaryGroups`. The unit fails to start if the
group doesn't exist.

## Two machines

Import `nixosModules.blitzcrank` on the agent machine and
`nixosModules.blitzcrank-mcp` on the media server, and enable one service on
each. Point the host's `mcpUrl` at the remote endpoint.

The bearer token goes with every request, so keep it off open networks. On
the media server, either set `services.blitzcrank-mcp.host` to a private
interface address, or keep loopback and put a TLS reverse proxy in front. The
module opens no firewall ports. The server needs no model or sign-in settings.

## Sign in on the server

The module installs the `blitzcrank` command. If a provider uses OAuth
instead of an API key, sign in once:

```sh
sudo blitzcrank auth login openai
sudo blitzcrank auth status
```

The command runs as the service user, with the service's environment and
credential path. It stops the service while it runs and puts it back in the
state it found it, running or stopped. Run it in an interactive terminal. SSH
works.

To restore credentials from a secret instead, set
`services.blitzcrank.authSeedFile`. The service copies the seed into place
only when the credential file is missing or the seed changed, so a rebuild
never overwrites refreshed tokens. Refresh tokens rotate, so the seed goes
stale after first use. It restores a host once, then the two drift apart.

## State

The host keeps its state in `/var/lib/blitzcrank`. Only one host process may
use that directory at a time. To back it up, stop the service first, or use a
SQLite-aware backup that includes committed WAL data.
[Logs and journals](operations.md#journals) lists what the directory holds.

The server keeps nothing on disk.

## Option reference

[`nix/module.nix`](../nix/module.nix) and
[`nix/mcp-module.nix`](../nix/mcp-module.nix) describe every option.
