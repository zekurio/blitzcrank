# Connect Fluxer

[Fluxer](https://fluxer.app) is an open-source chat platform. You can use
fluxer.app or host your own. It's the only chat platform blitzcrank listens
to.

## Create the bot

Your Fluxer account must be claimed, with a password or an SSO link, before
it can create an application.

1. In the Fluxer web client, open User Settings → Applications and create an
   application. Fluxer creates a bot account with it and shows the bot token
   once. The token looks like `<application id>.<secret>`.
2. Put the token in the host's environment file as `FLUXER_BOT_TOKEN`.
3. For a homelab, leave Public bot and Require OAuth2 code grant off, and add
   no redirect URIs.

Regenerate bot token issues a new token and disconnects the running bot.

## Invite it to your guild

Use the application's Bot invite URL builder, or open this on your instance's
web app:

```
/oauth2/authorize?client_id=<application id>&scope=bot&permissions=309237713920
```

That asks for View Channel, Send Messages, Read Message History, Create Public
Threads, and Send Messages in Threads. Whoever installs the bot needs
Administrator in the guild, or Manage Guild plus every permission they grant.

Consent creates a role named after the application with those permissions and
gives it to the bot. Fluxer feature-gates the two thread permissions, so the
role may arrive without them. If it does, add them to the role in the guild
settings.

At startup the host checks its permissions in every watched channel. It
refuses to start if a permission is missing, if a watched channel is in no
guild it can see, or if no guild state arrives within 30 seconds of the
connection being ready.

## Settings

`FLUXER_BOT_TOKEN` is a secret and goes in the host's environment file. The
rest go in `services.blitzcrank.settings` on NixOS, or in the host's `.env`.

| Variable                  | Required | Meaning                                                             |
| ------------------------- | -------- | ------------------------------------------------------------------- |
| `FLUXER_BOT_TOKEN`        | yes      | The bot token from the application                                  |
| `FLUXER_INSTANCE_URL`     | yes      | Instance origin with no path, such as `https://fluxer.app`          |
| `FLUXER_CHANNELS`         | yes      | Channel IDs the bot watches                                         |
| `FLUXER_ALLOWED_USERS`    | one of   | User IDs that get answers                                           |
| `FLUXER_ALLOWED_ROLES`    | one of   | Role IDs that get answers                                           |
| `FLUXER_ADMIN_USERS`      | one of   | User IDs that are admins                                            |
| `FLUXER_ADMIN_ROLES`      | one of   | Role IDs that are admins                                            |
| `FLUXER_TRIAGE_MODEL`     | yes      | Classifier that decides which messages to answer                    |
| `FLUXER_TRIAGE_THRESHOLD` | no       | Confidence needed without a mention, above 0 up to 1, default `0.8` |

ID lists are comma-separated. At least one of the four user and role lists
must have an ID, since there is no allow-all switch. The host stops at startup
if a required setting is missing or malformed.

The host reads the API and gateway addresses from `/.well-known/fluxer` on
the instance, so the origin is the only address you set.

### Triage model

`FLUXER_TRIAGE_MODEL` names a classifier, not a chat model. TypeSafe's Jev
works, through any of these:

| Model                                           | Key                  |
| ----------------------------------------------- | -------------------- |
| `opencode/jev-1.13` or `opencode/jev-1.13-free` | `OPENCODE_API_KEY`   |
| `openrouter/~typesafe/jev-latest`               | `OPENROUTER_API_KEY` |
| `typesafe/jev-latest`                           | `TYPESAFE_API_KEY`   |

The host refuses to start if the model is unknown or its provider has no key.

## Who gets an answer

The bot watches the channels in `FLUXER_CHANNELS` and nothing else. It
ignores DMs.

A member gets an answer if their user ID is in `FLUXER_ALLOWED_USERS` or they
hold a role in `FLUXER_ALLOWED_ROLES`. Admins, listed in `FLUXER_ADMIN_USERS`
or `FLUXER_ADMIN_ROLES`, get answers without being in the allowed lists. Only
an admin's request can remove or unmonitor media that plays fine.

Admin status belongs to one message. If an admin writes in a thread and a
member follows up, the member's request is still a member's.

The host checks the sender before any model sees the message, and again if
recovery resumes the run. If Fluxer can't be reached for the check, the
message gets no answer.

## What happens to a message

Triage reads every message from an allowed sender in a watched channel.

- If the message mentions the bot, the most likely label decides. A message
  triage can't judge opens a thread anyway. A reply to one of the bot's
  messages counts as a mention.
- Without a mention, triage must be at least `FLUXER_TRIAGE_THRESHOLD` sure
  that it's a homelab request.
- An off-topic message that mentions the bot gets a fixed denial line. One
  without a mention gets nothing.

A homelab request opens a thread named `blitzcrank: <title>`. The
[helper model](models.md) writes the title from the message, and if it fails,
the message text is used. Fluxer only makes the bot a member of a thread it
opens, so the bot adds the sender, and Fluxer posts a line saying so.

While the agent works, the bot keeps one message in the thread that shows the
current step, such as `🔍 Blitzcrank is checking Sonarr…`. It edits that
message at most once every 3 seconds, and picks the line from the tool's name
alone, never from the arguments. When the run ends, the reply replaces it.

Later messages in a bot thread are follow-ups. They skip triage and need no
mention.

## Connection

Fluxer has no gateway intents, so message content always arrives. The host
opens the connection to Fluxer, so it needs no inbound port.

If Fluxer closes the connection for good, for example after you regenerate
the token, the host exits with a failure and systemd restarts it. Messages
sent while the host is down are never picked up.
