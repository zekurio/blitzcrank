# Configuration

Blitzcrank requires a versioned JSON configuration file. Copy
[`blitzcrank.example.json`](../blitzcrank.example.json) to `blitzcrank.json`,
edit it, and set `BLITZCRANK_CONFIG` to its path:

```sh
BLITZCRANK_CONFIG=./blitzcrank.json pnpm dev
```

`BLITZCRANK_CONFIG` must be set and nonblank. A missing, unreadable, malformed,
or unsupported file stops startup. There is no file discovery or environment
configuration fallback. Environment variables supply only secrets explicitly
referenced by the JSON file and model-provider authentication.

The example config enables only Seerr. The bundled automations also need
Sonarr, Radarr, and Anvil. Configure those services before using the bundled
tasks, or point `automationsDir` at your own task definitions.

Unknown fields, wrong types, duplicate IDs, and incomplete services are errors.
`version` must be `1`. Changes require a process restart.

Relative `dataDir`, `automationsDir`, `authPath`, `modelsPath`, and secret file
paths resolve beside the configuration file. Service URLs must use HTTP or
HTTPS. Media roots and the Anvil socket must be absolute paths. `/` cannot be a
media root.

## Secrets

Every `apiKey`, Discord `token`, and `webhookSecret` accepts an environment
reference such as `{ "env": "SEERR_API_KEY" }`, or a file reference such as
`{ "file": "/run/credentials/blitzcrank.service/seerr-key" }`.

A reference must contain exactly one of `env` or `file`. Missing, blank, or
NUL-containing secrets stop startup. Blitzcrank removes trailing whitespace
from secret files. It does not interpolate `${...}` in ordinary strings.

Literal secret strings are also valid, but do not commit them. Put referenced
variables in the process environment or, under systemd, an environment file.
The pi SDK reads its normal provider authentication variables directly. The
NixOS module rejects inline secrets because generated configuration enters the
world-readable Nix store.

## File fields

Fields are optional unless marked required. Omit unused sections rather than
setting them to `null`.

| Field                                     | Meaning and default                                                   |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `version`                                 | Required, `1`.                                                        |
| `seerr`                                   | Required, `{ "url": "...", "apiKey": <secret> }`.                     |
| `sonarr`, `radarr`, `sabnzbd`, `jellyfin` | Same shape as `seerr`. Omitted services have no tools.                |
| `port`                                    | Integer from `0` to `65535`, default `8484`.                          |
| `dataDir`                                 | Durable state directory, default `data`.                              |
| `automationsDir`                          | Automation definitions directory, default `automations`.              |
| `webhookSecret`                           | Secret checked against HTTP `Authorization`.                          |
| `model`                                   | Issue model as `provider/model[:thinking]`.                           |
| `automationModel`                         | Default automation model, inherits `model`.                           |
| `automationModels`                        | Automation-name to model map, default `{}`.                           |
| `authPath`                                | Writable pi auth file. Omitted uses pi's default.                     |
| `modelsPath`                              | Optional pi custom-provider models file.                              |
| `language`                                | Reply language, default `German`.                                     |
| `seerrBotUserId`, `seerrBotUsername`      | Bot attribution and own-comment detection.                            |
| `anvil`                                   | `{ "socket": "/run/anvil/anvild.sock", "command": "anvilctl" }`.      |
| `media`                                   | `{ "roots": ["/mnt/media"] }`. Empty or omitted disables media tools. |
| `web`                                     | Default `{ "provider": "none" }`. Firecrawl requires `apiKey`.        |
| `gateways`                                | Optional gateway object. `{}` disables all chat gateways.             |

## Discord

One Discord bot and client handles every configured guild:

```json
{
  "gateways": {
    "discord": {
      "token": { "env": "DISCORD_BOT_TOKEN" },
      "guilds": [
        {
          "guildId": "100000000000000001",
          "reportChannelId": "100000000000000002",
          "inboxChannelIds": ["100000000000000003"],
          "adminRoleIds": ["100000000000000005"],
          "model": "provider/conversation-model",
          "triageModel": "provider/triage-model"
        }
      ]
    }
  }
}
```

Enabling Discord requires a token and at least one guild. Guild IDs must be
unique. `inboxChannelIds` and `adminRoleIds` must each be unique within their
guild and default to empty arrays. Discord IDs are numeric strings.
`guildId` and `reportChannelId` are required. `model` inherits the issue model,
and `triageModel` inherits the conversation model.

Blitzcrank validates every guild before it admits any Discord handlers. A client
startup failure disables Discord without disabling HTTP. Enable Message Content
Intent in the Discord developer portal when any guild has an inbox.

HTTP starts independently of Discord login. The host owns one pending login
attempt until it settles; it never starts a replacement client because login is
slow. The installed Discord SDK cannot safely cancel an in-flight login.
Shutdown waits within the host's process deadline, then process exit closes any
remaining connection. Reports produced before Discord is ready are logged as
undelivered rather than queued for later.

Inbox messages go through triage. Accepted messages open a private thread in
the same inbox. Other guilds, channels, bots, webhooks, and empty messages are
ignored. Channel access authorizes service changes and searches of earlier
agent sessions, so restrict inboxes to trusted users. Multi-item or destructive
actions still require approval for the exact scope.

All guilds share the serial work queue. Reports go to each guild's report
channel. Discord thread IDs are globally unique, so sessions and evidence stay
in `sessions/discord` and `evidence/discord`; this change needs no path or
namespace migration.

## NixOS

Set all application configuration under `services.blitzcrank.config`. The
module writes the JSON file and sets `BLITZCRANK_CONFIG`:

```nix
services.blitzcrank = {
  enable = true;
  environmentFile = "/run/secrets/blitzcrank.env";
  config = {
    seerr = {
      url = "http://jellyseerr.local:5055";
      apiKey.env = "SEERR_API_KEY";
    };
    webhookSecret.env = "BLITZCRANK_WEBHOOK_SECRET";
    media.roots = [ "/mnt/media" "/mnt/downloads" ];
    gateways.discord = {
      token.env = "DISCORD_BOT_TOKEN";
      guilds = [{
        guildId = "100000000000000001";
        reportChannelId = "100000000000000002";
        inboxChannelIds = [ "100000000000000003" ];
      }];
    };
  };
};
```

The module manages durable state under `/var/lib/blitzcrank`; do not set
`config.dataDir`. It defaults `config.authPath` to
`/var/lib/blitzcrank/auth.json`. A custom auth path must remain below
`/var/lib/blitzcrank` and keep the `auth.json` basename. The `blitzcrank-pi`
helper uses the same effective auth file.

Keep secret values in `environmentFile`, or use `file` references to runtime
secret paths. For systemd credentials, add the credential to
`systemd.services.blitzcrank.serviceConfig.LoadCredential` and reference its
absolute `/run/credentials/blitzcrank.service/<name>` path.
