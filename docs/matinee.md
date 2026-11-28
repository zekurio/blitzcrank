# Connect Matinee

The MCP server talks to [Matinee](https://github.com/zekurio/matinee) through
its REST API under `/api/v1`. It needs two settings in the server's
environment file, `MATINEE_URL` and `MATINEE_API_KEY`.

You need a Matinee release newer than v0.0.9. Earlier releases lack
[matinee#97](https://github.com/zekurio/matinee/pull/97), which lets a token
pick its permissions one by one.

## Make the token

1. Sign in to Matinee with the account the agent should act as. Your own admin
   account works. A separate account works better, see below.
2. Open Settings → API tokens and create a token with exactly these
   permissions:

   ```
   title.read title.update library.read library.scan media.read
   catalog.read adminRequest.read adminRequest.retry job.read request.create
   ```

3. Leave out `all`, `adminRequest.approve`, `adminRequest.decline`, and
   `request.autoApprove`.
4. Put the token in the server's environment file as `MATINEE_API_KEY`.

The [server README](../packages/mcp/README.md#matinees-token) maps each
permission to the tools that use it.

## What the token can do

Matinee checks every call against both the token and its account. The token
can only do what it lists, even on an admin account, and it needs each
permission it uses, reads included. If one is missing, Matinee answers 403
with the permission's name, and the tool passes that on as its error. The
server doesn't check permissions itself.

With the list above, the agent can read titles, files, tracks, libraries,
jobs, and the request queue. It can scan a library, refresh a title, fix a
match, retry a failed send, and request a title. It can't approve or decline
anything, including its own requests, so whatever it requests waits for an
admin. A leaked token reaches no users, groups, sessions, or settings.

## Use an account of its own

The token's account decides which libraries the agent sees and whose request
quota it spends. Every request from every chat comes from that account, so
all chats share one quota and Matinee can't show who asked. A dedicated
account keeps the agent's requests and quota apart from any person's.

## How media gets added

Matinee sends approved requests to Sonarr and Radarr itself, and its file
watcher picks up their imports. No webhook from the Arrs is needed.

No Sonarr or Radarr tool adds a title. A Matinee request is the only way the
agent adds media, and Matinee's connection rules pick the quality profile and
folder.

The agent has no tool for Matinee's live sessions, users, or groups. Every
run gets every read, and those would show who watches what.
