# blitzcrank

blitzcrank investigates media problems reported in Jellyseerr. It uses the
[pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) to read
service state, apply fixes through dedicated tools, and report back on the issue.
It connects to Seerr, Sonarr, Radarr, SABnzbd, Jellyfin, and optionally Anvil.

A report such as "wrong language" or "episode won't play" starts an agent
session. Follow-up comments continue that session. Scheduled automations handle
recurring chores, and an optional Discord inbox supports private conversations
with the same service tools.

This project is built for one private homelab. Expect sharp edges.

- [Deploy on NixOS](#deploy-on-nixos)
- [Connect Jellyseerr](#connect-jellyseerr)
- [Configure models and services](#configure-models-and-services)
- [Run automations](#run-automations)
- [Set up Discord](#set-up-discord)
- [Understand the safety rules](#safety-rules)
- [Develop locally](#develop-locally)

## Deploy on NixOS

Add blitzcrank to your flake inputs:

```nix
inputs.blitzcrank.url = "github:zekurio/blitzcrank";
```

Import and configure the module:

```nix
{
  imports = [ inputs.blitzcrank.nixosModules.default ];

  services.blitzcrank = {
    enable = true;
    model = "openai-codex/gpt-5.2-codex";
    environmentFile = "/run/secrets/blitzcrank.env";
    settings.SEERR_BOT_USERNAME = "blitzcrank";
  };
}
```

Put service URLs, API keys, and `BLITZCRANK_WEBHOOK_SECRET` in the environment
file. `SEERR_URL` and `SEERR_API_KEY` are required. See
[`.env.example`](.env.example) for every setting.

The service stores case files, session transcripts, Discord conversations, and
provider credentials in `/var/lib/blitzcrank`. Keep `auth.json` writable so pi
can refresh OAuth tokens.

### Provider login

For OAuth or subscription authentication, run this on the deployed host:

```bash
sudo blitzcrank-pi
```

Use `/login` or `/logout` in the pi CLI. The helper uses
`/var/lib/blitzcrank` as its agent directory and stops `blitzcrank.service`
while the CLI owns the auth file. On exit or interruption, it restores the
service's previous running or stopped state. It needs an interactive terminal
and works over SSH.

For declarative authentication, set:

```nix
services.blitzcrank.authSeedFile = "/run/secrets/pi_auth_json";
```

The module loads the secret as a systemd credential. It copies the secret to
`authFile` only when that file is missing or the secret changes, so ordinary
rebuilds preserve refreshed tokens. Use this option if you customize
`authFile`; the interactive helper always writes the default path.

The unmanaged CLI is also available as `blitz-pi`. Use `blitzcrank-pi` to
manage the deployed service's credentials.

### HTTP endpoints

The server listens on `BLITZCRANK_PORT`, which defaults to `8484`.

| Method | Path                     | Purpose                   |
| ------ | ------------------------ | ------------------------- |
| `POST` | `/webhook/seerr`         | Receive Jellyseerr events |
| `GET`  | `/healthz`               | Check server health       |
| `GET`  | `/automations`           | List automations          |
| `POST` | `/automations/:name/run` | Start an automation       |

When `BLITZCRANK_WEBHOOK_SECRET` is set, every endpoint except `/healthz`
requires its value in the `Authorization` header.

## Connect Jellyseerr

Open **Settings → Notifications → Webhook** in Jellyseerr and configure:

| Setting              | Value                                         |
| -------------------- | --------------------------------------------- |
| URL                  | `http://<blitzcrank-host>:8484/webhook/seerr` |
| Authorization header | Your `BLITZCRANK_WEBHOOK_SECRET`, if set      |
| Payload              | Keep the default JSON template                |
| Notification types   | Enable the Issue events                       |

Set `SEERR_BOT_USERNAME` to the bot's display name and `SEERR_BOT_USER_ID` to
the user it should comment as. These identify the bot's comments and prevent
webhook loops.

### What happens after a report

1. Jellyseerr sends the issue webhook. blitzcrank queues an agent run.
2. The agent reads service state and uses dedicated tools to make verified
   changes. Movie issues get Radarr tools; TV issues get Sonarr tools. An
   unknown media type gets neither.
3. The host posts the result, resolves the issue if requested, and schedules
   a revisit if work needs time to finish.

Each issue keeps one agent session and its service evidence across replies.
Only the reporter or a Seerr user with `ADMIN` or `MANAGE_ISSUES` may start a
run by commenting. If Seerr is unreachable, the authorization check rejects
the comment.

A run leaves at most one comment. Progress updates edit that comment, and the
final response replaces it. The bot ignores its own comment webhooks and
`ISSUE_RESOLVED` events.

Revisits wait between 10 minutes and 48 hours. There are at most three between
user messages, with doubled delays when a revisit finds nothing new. New user
activity cancels pending revisits. Pending revisits survive restarts.

### Pause an issue

An authorized user can comment `/blitzcrank stop` to finish in-flight tool
calls, stop the active turn, clear queued and scheduled work, and pause the
issue. The pause survives restarts. blitzcrank ignores ordinary comments until
an authorized user posts `/blitzcrank resume`.

Resuming allows new events. It does not replay stopped work or undo completed
changes. Usage and session evidence remain in the audit record.

### Comment usage totals

Each public comment ends with the model and the issue's cumulative token usage:

```text
[blitzcrank w/ gpt-5.2-codex:high · 118.2k in · 14.2k out]
```

API-key authentication adds a cumulative price estimate, such as `· $0.42`.
Legacy issues without cost history show the current run's estimate instead.
Subscription authentication omits cost because API list prices do not represent
subscription spending.

## Configure models and services

Configuration uses environment variables. [`.env.example`](.env.example) is the
full reference. Optional service tools are available only when configured.

### Model selection

Model values use `provider/model[:thinking]`.

| Setting                           | Applies to                                   | Default or fallback                  |
| --------------------------------- | -------------------------------------------- | ------------------------------------ |
| `BLITZCRANK_MODEL`                | Issue runs                                   | `anthropic/claude-sonnet-4-5:medium` |
| `BLITZCRANK_AUTOMATION_MODEL`     | Automations                                  | `BLITZCRANK_MODEL`                   |
| `BLITZCRANK_AUTOMATION_MODELS`    | Named automation overrides, as a JSON object | Automation default                   |
| `BLITZCRANK_DISCORD_MODEL`        | Discord conversations                        | `BLITZCRANK_MODEL`                   |
| `BLITZCRANK_DISCORD_TRIAGE_MODEL` | Discord inbox classification                 | Conversation model                   |

For example, this overrides one automation:

```dotenv
BLITZCRANK_AUTOMATION_MODELS={"stale-import-handler":"openai-codex/gpt-5.6-terra:high"}
```

The Nix module exposes automation defaults and overrides as:

```nix
services.blitzcrank = {
  automationModel = "anthropic/claude-sonnet-4-5:medium";
  automationModels.stale-import-handler = "openai-codex/gpt-5.6-terra:high";
};
```

The pinned pi SDK 0.85.1 supports GPT-6 Astra. Use
`openai-codex/gpt-6-astra:medium` for Codex subscription authentication or
`openai/gpt-6-astra:medium` with `OPENAI_API_KEY`. Supported reasoning levels
are `low`, `medium`, `high`, `xhigh`, and `max`. Your account must have access.
Automation and Discord overrides take precedence over the shared model.

### Credentials and custom providers

pi reads the usual provider environment variables, such as
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. OAuth and subscription providers use
a writable pi `auth.json`.

On NixOS, use the [provider login helper](#provider-login). Elsewhere, log in
with pi and set `BLITZCRANK_AUTH_PATH` to its writable auth file. The default
is `~/.pi/agent/auth.json`.

Set `BLITZCRANK_MODELS_PATH` to a `models.json` file to define custom providers.

### Media inspection

Set `BLITZCRANK_MEDIA_ROOTS` to colon-separated absolute directories containing
media and completed downloads. `media_probe` uses ffprobe to inspect streams,
including their languages. `media_frames` uses ffmpeg to return up to six JPEG
frames at requested timestamps for wrong-movie or wrong-episode reports. Frame
inspection also requires a model that accepts images.

These tools accept only service-supplied paths read during the current run.
They resolve symlinks before checking that files are inside the allowed roots.
Frames and stream metadata do not authorize changes or establish target IDs.

### Web access

Set `BLITZCRANK_WEB_PROVIDER=firecrawl` and `FIRECRAWL_API_KEY` to add web
search and extraction to issue runs and Discord conversations. Web access is
off by default. On NixOS, use `services.blitzcrank.webProvider`.

`web_search` returns snippets. `web_extract` opens one page per call, and only
if the current run's search returned its URL. Web content is untrusted and
cannot authorize a change.

Firecrawl must use its hosted API. blitzcrank rejects custom endpoints because
it cannot enforce a remote fetcher's DNS and redirect policy.

### Anvil

Set `ANVIL_CONTROL_SOCKET` to enable status reads, exact-path job lookups,
diagnostics, and retry of a diagnosed failed encode. Anvil tools use `anvilctl`
over its control socket. They never open its store.

`ANVIL_COMMAND` defaults to `anvilctl`. Set an absolute path if the executable
is not on the service's `PATH`. On NixOS, use Anvil's standalone client package
and grant access to its socket group:

```nix
services.blitzcrank.settings = {
  ANVIL_CONTROL_SOCKET = "/run/anvil/anvild.sock";
  ANVIL_COMMAND =
    "${inputs.anvil.packages.${pkgs.system}.anvilctl}/bin/anvilctl";
};
systemd.services.blitzcrank.serviceConfig.SupplementaryGroups = [ "anvil" ];
```

Job lookups correlate exact paths only. Empty or incomplete results mean the
state is unknown. Retry is the only Anvil mutation available to the agent;
cancellation and library or store maintenance remain operator-only.

## Run automations

Automation definitions live in [`automations/`](automations). Each Markdown
file declares a cron schedule and the exact mutation tools it may use. Its body
contains trusted operator instructions. For example, the frontmatter can be:

```yaml
---
name: stale-import-handler
schedule: "0 */3 * * *"
mutation_tools:
  - sonarr_delete_queue_item
---
```

Automations get read tools plus their declared mutation tools. Model selection
belongs in deployment configuration, not the task file. Changing a model does
not change tool access or evidence requirements.

NixOS uses the bundled definitions by default. Set `automationsDir` to use your
own. The bundled `stale-import-handler` requires Sonarr, Radarr, and Anvil.
Startup fails if a declared tool is unavailable, a model override names an
unknown automation, or a selected model is unavailable.

Cron, `POST /automations/:name/run`, and Discord can start runs. Each automation
can run only once at a time; another request for a busy name returns `409`.
The agent finishes through `submit_automation_report`. The host uses that tool's
validated `status` and `body` as the report.

## Set up Discord

### Automation reports and commands

Discord is off unless `DISCORD_BOT_TOKEN` is set. Enabling it also requires
`DISCORD_GUILD_ID` and `DISCORD_WATCH_CHANNEL_ID`.

Each automation posts to a private `automation: <name>` thread in the watch
channel. Reports include runs with nothing to do, so you can see that the
schedule is still working. The report header shows the structured status;
internal history markers are removed before delivery.

- `/automation list` shows schedules and next runs.
- `/automation run name:<x>` queues a run.

Administrators can trigger runs. Set `DISCORD_ADMIN_ROLE_IDS` to grant that
access to additional roles.

### Bot permissions

Invite the bot with the `bot` and `applications.commands` scopes. Grant these
permissions in the watch channel:

- View Channel
- Send Messages
- Send Messages in Threads
- Create Private Threads
- Manage Threads
- Read Message History, which lets the bot find archived report threads

Keep the watch channel admin-only. blitzcrank does not edit permissions.
If you need to remove a report thread, delete it; the next run creates another.
Avoid locking threads, since reviving one requires Manage Threads permission
on the thread itself.

On startup, blitzcrank replaces the configured guild's command set. Use a
separate Discord application for this bot.

### Private operations inbox

Set `DISCORD_INBOX_CHANNEL_ID` and enable Message Content Intent in the Discord
developer portal. Grant the bot the same thread permissions in the inbox.
Restrict channel access to trusted users: access allows service changes and
searches of prior conversations.

Each plain-text message goes to a classifier with no service or read tools.
For accepted messages, the host opens a private `blitzcrank: <topic>` thread,
adds the sender, and posts a source card with the original text, author, and
message link.

Replies continue one persistent agent session. It can use all configured
service reads and typed mutations, including both Sonarr and Radarr. Multi-item
or destructive work requires prior conversation approval for the exact scope.
The host posts replies with mentions blocked. The agent cannot write to Discord
or change Seerr issue status.

The agent can search bounded snippets from earlier blitzcrank Seerr and Discord
sessions. Searches exclude the current thread and automation transcripts.
History is untrusted context, not permission or current service evidence.
Each thread retains service evidence, but the agent must read mutable state,
file paths, and reusable Anvil slugs again before using them.

Private threads are visible to the invited sender and members with Manage
Threads permission. Those members can also drive the conversation by replying.
Use `BLITZCRANK_DISCORD_TRIAGE_MODEL` to choose a cheaper model for the initial
classification pass.

## Safety rules

The agent can change media services, so the tool layer enforces these limits:

- Raw `*_request` tools are GET-only. SABnzbd raw reads are limited to `queue`
  and `history`. Every mutation has a dedicated tool and requires a reason.
- Mutation targets must come from accepted service reads. The code rejects
  guessed IDs. Meaningful changes include a verification read-back.
- A multi-episode Sonarr search must state the true episode count. Replacing
  two or more existing files requires inspecting at least one with
  `media_probe` during the current run.
- Issue, Discord, and automation runs have no mutation or deletion quotas.
  Changes remain counted and audited. Issue prompts require the agent to
  establish the full scope, tell the reporter, and act on exactly that scope.
- Each resumed session gets a fresh system prompt and tool list while keeping
  its conversation and service evidence.
- The host posts comments, resolves issues, and schedules revisits. The agent
  returns `RESOLVE_ISSUE` and optional `REVISIT_IN` and `REVISIT_REASON`
  directives. Malformed directives result in no comment.

[AGENTS.md](AGENTS.md) records the full safety invariants and their rationale.
The [legacy deployment notes](docs/research/legacy.md) describe the earlier Go
implementation.

## Develop locally

The Nix dev shell includes Node 26, pnpm 11, and TypeScript:

```bash
nix develop          # or: direnv allow
pnpm install
cp .env.example .env # fill in service URLs and API keys
pnpm dev             # tsx watch
```

The shell exposes the checkout's pinned pi CLI as `blitz-pi` to avoid collisions
with other `pi` installations.

Without Nix, install Node >= 26.0.0 and pnpm 11, then follow the commands after
`nix develop`. To compile and run the output:

```bash
pnpm build
pnpm start
```

Run `pnpm verify` before opening a pull request. It checks formatting, lint,
and types. [AGENTS.md](AGENTS.md) covers code style and contribution rules;
[`skills/`](skills) and [`docs/research/`](docs/research) contain agent domain
knowledge and API references.

## Contributing

[Open an issue](https://github.com/zekurio/blitzcrank/issues/new) to report a
bug or propose a change. Pull requests that change available tools, evidence
gates, session resumption, or the directive protocol must describe that change
explicitly.

## License

[MIT](LICENSE)
