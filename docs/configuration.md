# Configuration

Use a versioned JSON file for new deployments. Copy
[`blitzcrank.example.json`](../blitzcrank.example.json) to `blitzcrank.json`,
edit the service settings, then set `BLITZCRANK_CONFIG` to its path. The local
`blitzcrank.json` is git-ignored.

```sh
BLITZCRANK_CONFIG=./blitzcrank.json pnpm dev
```

Supply the secrets referenced by that file through your service environment or
secret manager. The example requires `SEERR_API_KEY` and
`BLITZCRANK_WEBHOOK_SECRET`. It does not configure optional services; add the
ones your automation definitions need before starting.

## Selection and validation

- With no `BLITZCRANK_CONFIG`, existing env-only deployments keep working.
  [`.env.example`](../.env.example) documents those settings.
- With `BLITZCRANK_CONFIG`, the file is the entire application configuration.
  Legacy setting variables do not override it or fill omitted fields. Explicit
  secret references still read environment variables. The pi SDK also continues
  to read its normal provider-auth environment variables.
- A missing, unreadable, malformed, or unsupported file stops startup. There is
  no fallback to env configuration. Unknown fields, wrong types, duplicate
  gateway or inbox IDs, and partially configured services are errors.
- `version` must be `1`. Changes require a process restart; there is no reload.
- Relative `dataDir`, `automationsDir`, `authPath`, `modelsPath`, and secret-file
  paths resolve beside the config file. Default `data` and `automations` paths
  do too. In env mode, relative paths resolve from the working directory.
- Service URLs must use HTTP or HTTPS. Media roots and the Anvil socket must be
  absolute paths. The filesystem root is never a permitted media root.

## Secrets

Every `apiKey`, gateway `token`, and `webhookSecret` accepts:

```json
{ "env": "SEERR_API_KEY" }
```

or:

```json
{ "file": "/run/credentials/blitzcrank.service/seerr-key" }
```

A reference must contain exactly one of `env` or `file`. Missing or empty
secrets stop startup. Secret files have trailing whitespace removed, so a
newline from a secret manager is harmless. There is no `${...}` interpolation
in ordinary strings.

Manually managed JSON files also accept literal secret strings, but references
are preferable. Never commit secrets. The Nix module rejects inline secrets
because its generated config is stored in the world-readable Nix store.

## File fields

Fields are optional unless marked required. Omit unused sections rather than
setting them to `null`.

| Field                                     | Meaning and default                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `version`                                 | Required, `1`.                                                                                                       |
| `seerr`                                   | Required, `{ "url": "...", "apiKey": <secret> }`.                                                                    |
| `sonarr`, `radarr`, `sabnzbd`, `jellyfin` | Same shape as `seerr`. Omitted services have no tools.                                                               |
| `port`                                    | Integer from `0` to `65535`, default `8484`. `0` requests an ephemeral port.                                         |
| `dataDir`                                 | Durable state directory, default `data`.                                                                             |
| `automationsDir`                          | Automation definitions directory, default `automations`.                                                             |
| `webhookSecret`                           | Secret checked against HTTP `Authorization`. Omitted means no HTTP shared-secret check.                              |
| `model`                                   | Issue model as `provider/model[:thinking]`. Uses the built-in default when omitted.                                  |
| `automationModel`                         | Default automation model, inherits `model`.                                                                          |
| `automationModels`                        | Object mapping automation names to model specs, default `{}`.                                                        |
| `authPath`                                | Writable pi auth file. Omitted uses pi's `~/.pi/agent/auth.json`.                                                    |
| `modelsPath`                              | Optional pi custom-provider models file.                                                                             |
| `language`                                | Default reply language, default `German`.                                                                            |
| `seerrBotUserId`, `seerrBotUsername`      | Bot attribution and own-comment detection. IDs are strings.                                                          |
| `anvil`                                   | `{ "socket": "/run/anvil/anvild.sock", "command": "anvilctl" }`. Socket required; command defaults to `anvilctl`.    |
| `media`                                   | `{ "roots": ["/mnt/media", "/mnt/downloads"] }`. Empty or omitted disables media tools.                              |
| `web`                                     | Default `{ "provider": "none" }`. Opt in with `{ "provider": "firecrawl", "apiKey": <secret> }`. No custom endpoint. |
| `gateways`                                | List of independently configured chat connections, default `[]`.                                                     |

## Discord gateways and multiple inboxes

```json
{
  "version": 1,
  "seerr": {
    "url": "http://jellyseerr.local:5055",
    "apiKey": { "env": "SEERR_API_KEY" }
  },
  "gateways": [
    {
      "id": "discord",
      "type": "discord",
      "token": { "env": "DISCORD_BOT_TOKEN" },
      "guildId": "100000000000000001",
      "reportChannelId": "100000000000000002",
      "inboxChannelIds": ["100000000000000003", "100000000000000004"],
      "adminRoleIds": ["100000000000000005"]
    }
  ]
}
```

`id`, `type`, `token`, `guildId`, and `reportChannelId` are required. `id` must
be unique, lowercase kebab-case, and at most 64 characters. Discord IDs are
numeric strings, not JSON numbers. `inboxChannelIds` and `adminRoleIds` default
to empty lists. Optional `model` inherits the issue model; `triageModel`
inherits the conversation model.

Each configured inbox must be a text channel in that gateway's guild. The bot
verifies every inbox and the report channel during startup. Enable Message
Content Intent in the developer portal if any inbox is configured. With no
inboxes, the client declares no gateway intents.

Messages from any listed inbox go through triage. Accepted messages open a
private thread in that same inbox. Replies are accepted only in bot-owned
private conversation threads under listed inboxes. Other guilds, channels,
bots, webhooks, and empty messages are ignored.

Channel access authorizes service changes and searches of earlier Seerr and
Discord conversations, including conversations on other configured gateways.
Gateways are connections to one trusted homelab, **not tenant boundaries**.
Restrict every inbox to trusted users and keep report channels admin-only.
Multi-item or destructive actions still require approval for the exact scope.

Add more `type: "discord"` entries to connect additional bot/guild pairs.
Use a different gateway ID for each. Repeating the same bot token and guild
is rejected; put that connection's inboxes in one list instead. All gateways
share the serial work queue. Automation reports go to every running gateway's
report channel. A failed gateway does not disable the other connections or
HTTP triggers. Connections start concurrently, with a 30-second startup
deadline and up to five seconds for failure cleanup. Agent work still runs
serially; the connection deadline never interrupts an active service mutation.

The legacy env configuration maps to gateway ID `discord`. Keep that ID when
migrating to preserve existing conversation sessions and evidence. Other IDs
use separate directories below `sessions/gateways/<id>` and
`evidence/gateways/<id>`. Renaming a gateway starts a new conversation namespace;
do not rename one casually.

Only Discord is implemented today. The host interfaces use conversation IDs
and delivery callbacks; they do not require private threads. Thread creation,
message formatting, command authorization, and platform permissions belong to
the adapter. A future Fluxer adapter must define its own conversation and
authorization behavior rather than imitate Discord threads.

## NixOS

Set `services.blitzcrank.config` to the structured configuration. The module
generates JSON and supplies `BLITZCRANK_CONFIG`:

```nix
services.blitzcrank = {
  enable = true;
  environmentFile = "/run/secrets/blitzcrank.env";
  mediaRoots = [ "/mnt/media" "/mnt/downloads" ];
  config = {
    seerr = {
      url = "http://jellyseerr.local:5055";
      apiKey.env = "SEERR_API_KEY";
    };
    webhookSecret.env = "BLITZCRANK_WEBHOOK_SECRET";
    gateways = [
      {
        id = "discord";
        type = "discord";
        token.env = "DISCORD_BOT_TOKEN";
        guildId = "100000000000000001";
        reportChannelId = "100000000000000002";
        inboxChannelIds = [
          "100000000000000003"
          "100000000000000004"
        ];
      }
    ];
  };
};
```

`config.version` defaults to `1`. Existing convenience options such as `port`,
`model`, `automationModel`, `automationModels`, `automationsDir`, `authFile`,
`language`, `webProvider`, and `mediaRoots` supply defaults. Explicit structured
values replace those defaults. Structured `media.roots` also controls ffmpeg
availability, mount dependencies, and sandbox access. Auth seeding follows the
effective `authPath`.

Keep secret values in `environmentFile` or use `file` references to runtime
secret paths. For systemd credentials, add the credential to
`systemd.services.blitzcrank.serviceConfig.LoadCredential` and reference its
absolute `/run/credentials/blitzcrank.service/<name>` path. Merely naming a
credential file does not configure systemd to load it.

When `config` is unset, the old Nix env configuration still works. Do not combine
structured `config` with legacy `settings`; the module rejects that ambiguity.
Move service URLs and routing settings into `config`, and explicitly reference
every needed secret from the environment file.
