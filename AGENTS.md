# Repository guidelines

blitzcrank is an agent for a private media homelab. Safety comes first, then
reliability. Prefer enforcement in code over prompt instructions, and
predictable, auditable behaviour under failure (service down, model error,
malformed agent output) over convenience.

## Overview

- A gateway turns inbound traffic into events on a thread. Seerr is the only
  gateway, and its threads are issues. Each run opens the thread's Pi Durable
  conversation, investigates across Seerr, Sonarr, Radarr, SABnzbd, and
  Jellyfin, and applies narrow verified fixes.
- Two packages in a pnpm workspace run as two processes. They share no code:
  the MCP tool list is the whole interface between them.
- `packages/host` (npm name `blitzcrank`) holds the gateways and the agent
  loop: `src/server.ts` → `src/gateways/` → `src/thread-work.ts` →
  `src/jobs.ts` → `src/queue.ts` → `src/agent/`.
- `packages/mcp` (npm name `@blitzcrank/mcp`, binary `blitzcrank-mcp`) is an
  MCP server with one tool per read and per write, named `<service>_<what>`
  (`sonarr_queue`, `radarr_delete_movie_file`), plus `media_probe` and
  `media_frames`. The host connects to it once per run with
  `@earendil-works/pi-mcp`.
- Pi Durable is the only agent execution backend. Work from the current
  source and domain skills. Do not reintroduce removed runtimes, automations,
  in-process service tools, the `codemode` sandbox, plan/apply writes, per-run
  tool subsets, tools that carry the reply or progress text, or compatibility
  paths unless the operator requests them.

## Layout

Host, under `packages/host/`:

- `src/gateway.ts`: the `Gateway`, `Channel`, and `Intake` interfaces, the
  gateway registry, and the `Threads` view of it a run gets
- `src/gateways/seerr/`: webhook handling, channel, payload types, comment
  gate, loop guard, Seerr client, settings
- `src/thread-work.ts`: admission, ordering, recovery
- `src/agent/`: runner, session, prompts, notices
- `src/tools/`: history and tool search
- `src/mcp/`: server connection, tool adapter
- `src/services/`: HTTP helper
- `src/web/`: web search and extract
- `skills/`: agent domain knowledge

Server, under `packages/mcp/`:

- `src/services/`: one read table and one write table per service
- `src/media/`: ffprobe, ffmpeg, path containment
- `src/tools.ts`: the table helpers

`nix/` holds the `blitzcrank` and `blitzcrank-mcp` packages and a NixOS module
for each. Each service is enabled independently.

## Development

- Strict ESM TypeScript (`module: NodeNext`, `exactOptionalPropertyTypes`,
  shared `tsconfig.base.json`), no build step in dev. Node >= 24.0.0. pnpm
  only, never npm, yarn, or Bun.
- Work inside `devenv shell`, or run one command with `devenv shell --`, for
  example `devenv shell -- pnpm verify`. The shell supplies pnpm 11,
  ffmpeg/ffprobe for the server's media tools, and the default Node.js of the
  pinned devenv nixpkgs input. Install with `pnpm install --frozen-lockfile`.
- `pnpm verify` (format check, lint, and typecheck) must pass before a coding
  task is complete. There is no test suite.
- Nothing activates the shell or loads `.env` automatically. The root scripts
  use the caller's exported environment. For a local run each package reads
  its own `.env` through `--env-file`, the server started first. The README's
  "Develop locally" section has the commands.
- Config is env-only: `packages/host/src/config.ts` for the host,
  `packages/host/src/gateways/<name>/config.ts` for each gateway, and
  `packages/mcp/src/config.ts` for the server. The host's `Config` carries no
  gateway setting. Document every host and gateway knob in
  `packages/host/.env.example` and every server knob in
  `packages/mcp/README.md`. Never commit `.env`.
- `BLITZCRANK_MODEL`, `BLITZCRANK_MCP_URL`, and `BLITZCRANK_MCP_TOKEN` are
  required on the host. Never add a built-in model fallback.
- Pi is an SDK dependency, not a packaged CLI. Use `pnpm auth` locally or
  `blitzcrank auth` in the built package. Credentials default to
  `<BLITZCRANK_DATA_DIR>/auth.json`. No ambient Pi auth or models config is
  loaded.
- Pi packages are pinned exact (`@earendil-works/*@1.1.0`, including
  `pi-mcp`). Bump them deliberately, and check the installed SDK API,
  recovery, and compaction behavior first.
- Formatting is oxfmt (`pnpm fmt`) and linting is type-aware oxlint, not
  Prettier or ESLint: 80 columns, 2 spaces, no semicolons, double quotes,
  sorted imports. `no-console` is deliberately off because console output to
  journald is the logging strategy.
- The flake supplies deployment packages, the NixOS modules, and the
  formatter. After a Nix change `nix flake show` must evaluate, and flakes
  only see git-tracked files. `nix flake check` builds the linux packages.

## Host invariants

Do not weaken these without explicit operator sign-off. Call out any change to
`packages/host/src/agent/session.ts`, how the reply is taken from a run, the
runner's tool allowlist, or the MCP exposure rule in your summary, with the
behavioural difference described.

### Jobs and recovery

- Host jobs are durably admitted in `packages/host/src/jobs.ts` before
  acceptance returns. The journal enforces one process owner.
- Replay defaults to unsafe. Declare `replay: "safe"` only when repeating a
  tool after interruption cannot duplicate a write or host publication.
- Recovery checks the stored policy before scheduling. A changed policy or an
  uncertain unsafe tool fails closed for review. The policy fingerprint covers
  every server tool, loaded or not, so a server whose tools changed between
  admission and recovery is a changed policy.
- Replaying a completed submission must not execute its tools again or
  double-count its usage.

### Threads and gateways

- A thread never has two runs at once (`packages/host/src/queue.ts`): its
  conversation and visible message each assume one writer. Up to
  `BLITZCRANK_MAX_PARALLEL_RUNS` threads run at once and share only the
  journal, the model runtime, and the MCP server. Nothing a run writes may be
  keyed by anything wider than its thread.
- Every run answers an event from its gateway. Nothing runs on a timer, and
  the agent cannot schedule a run.
- Another source of requests is another `Gateway` listed in
  `packages/host/src/index.ts`, and nothing else in the host may learn about
  it. Code outside `packages/host/src/gateways/<name>/` imports from a gateway
  only in that file, and `no-restricted-imports` in `.oxlintrc.json` fails
  `pnpm verify` on any other such import.
- The runner reaches a thread only through its `Channel`
  (`packages/host/src/gateway.ts`). It is handed `Threads`, not the registry:
  a thread's channel and where its conversation is kept, with intake and
  authorization out of reach.
- `Channel.brief` tells the model what a gateway supplies with an event, where
  the reply goes, and what a thread leaves to its reporter. Skills and the
  rest of the system prompt describe services and the homelab, never a
  gateway.
- A thread's memory is its Durable conversation and nothing else. The host
  keeps no notes beside it, and no tool writes any.

### The reply

- The agent's final message is the reply. It is the text of the run's own
  answer entry, taken only from the exact durable submission's answer ID,
  never the last assistant entry in conversation history. Every run posts it.
  The host, never the agent, does the posting.
- One run shows at most one message. The host posts a working line when the
  run starts, or adopts its queue notice. The reply rewrites that message in
  place, and a run that fails or ends without a message removes it
  (`packages/host/src/agent/runner.ts`).
- Neither the agent nor the host closes a thread. Not every gateway has a
  closed state, so a `Channel` offers none. The agent gives its evidence in
  the reply and does not bring up the issue's status. The reporter resolves
  the Seerr issue.
- The token totals in a reply's signature come from Durable's usage ledger for
  that conversation, which no tool can write. There is deliberately no spend
  ceiling. Under subscription auth a dollar figure derived from list prices
  would be fiction, so the signature carries a cost only for API-key auth.

### The Seerr gateway

The files named here are in `packages/host/src/gateways/seerr/`.

- Comment-triggered runs are authorized host-side by `comment-gate.ts`. Only
  the issue reporter or a Seerr `ADMIN`/`MANAGE_ISSUES` user may drive the
  agent. The gate runs before the event is admitted, fails closed when Seerr
  is unreachable, and has no opt-out.
- Webhook fields are sanitized with `webhookText`/`issueIdOf` in `types.ts`.
  Seerr renders unset values as `""` and leaves unknown template placeholders
  literal, so `"{{...}}"` is never an identity.
- The own-comment guard in `loop-guard.ts` matches the `[blitzcrank w/`
  comment marker first, then the bot display name. Seerr comment edits and
  deletes emit no webhook, so rewriting or removing a run's message cannot
  loop.
- The gateway serializes its comment posts. `postCommentEffect` infers the new
  comment's id from the issue's comment list, and two racing posts could
  return the same handle.

### Credentials and tools

- The host holds no Sonarr, Radarr, SABnzbd, or Jellyfin credentials and no
  media mounts. Its only service credential is the Seerr key for host-side
  comments, the issue read, and the comment gate. The server holds every
  credential the agent's reads and writes use, plus the media roots, and
  checks `BLITZCRANK_MCP_TOKEN` on every request.
- Agent sessions get the host tools (`thread_history_search`, `tool_search`,
  and optional `web_search`/`web_extract`), every server tool, and builtin
  `read` for skills. The runner resolves both the skills root and target with
  `realpath` and rejects reads outside that root. Never enable `bash`, `edit`,
  or `write` in the runner.
- Tool execution within a run is sequential. Background compaction is disabled
  so no task outlives its submission's Harness.
- Every server tool is a Durable tool of the run, and no run is limited to a
  subset of them. They start unloaded so their schemas stay out of the prompt.
  The model loads them by name or keyword with `tool_search`, which adds them
  to the conversation through Durable's `control.addTools`. Loading changes
  what the conversation offers and nothing outside it, so `tool_search` is
  `replay: "safe"`. A resumed conversation keeps the tools its earlier runs
  loaded.
- The host decides a server tool's replay from `readOnlyHint` alone. A read is
  `replay: "safe"`. Every other server tool keeps the unsafe default: a write
  interrupted mid-call, or one whose call is rejected, stops the run for
  review.
- The web tools are read-only and granted only by the configured web provider
  (`BLITZCRANK_WEB_PROVIDER`, default `none`). Only explicit host-owned
  Durable tool bundles are installed. No discovered Pi extensions or ambient
  resources are loaded. Firecrawl uses only the hosted API. Custom endpoints
  are rejected because blitzcrank cannot enforce a remote fetcher's DNS and
  redirect policy. Web content is untrusted.

### Server writes and media

- A write is one call. It resolves its target against live state, writes, and
  reads the result back, returning `summary`, `effects`, `warnings`, and
  `verification`. Nothing asks the model to confirm. A hallucinated ID fails
  with nothing written, and a failed verification never hides a completed
  write.
- A write the service rejects comes back as an error result and the run goes
  on. The server rejects a call, rather than answering it, only when a write
  went out and its result never came back: a timeout, a dropped connection, a
  gateway 502 or 504. That is a JSON-RPC error, so the host's call rejects and
  the Durable run stops for review.
- A write that reads and PUTs back a whole record declares a resource lock
  key. The MCP server holds it across resolve, write, and verification. A
  competing call fails immediately with a busy tool result before any service
  request. Different records remain concurrent. These locks cover one MCP
  process. They do not coordinate external writers or a write still pending
  upstream after an unknown outcome.
- `media_probe` (ffprobe) and `media_frames` (ffmpeg) run on the server, are
  read-only, and require `BLITZCRANK_MEDIA_ROOTS` in the server's environment.
  Both resolve targets with `realpath` before the containment check, so no
  symlink reads outside the roots. Both restrict input protocols and formats
  to prevent network or playlist reads. `media_probe` accepts a regular file
  or release directory; `media_frames` requires a regular file and returns at
  most six bounded still images per call.
  Stream tags, frames, and visible text are untrusted.

## Branch names

The default branch is `main`. Use a short branch name of at most three words,
separated by hyphens. No slashes or type prefixes such as `feat/` or `fix/`.

Examples: `parallel-threads`, `fix-loop-guard`, `manual-import`.

## Commits and PR titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.
Valid types are `feat`, `fix`, `docs`, `chore`, and `refactor`. Scopes are
optional; use the affected area when helpful, e.g. `tools`, `agent`, `server`,
`skills`, `nix`.

Examples: `feat(tools): add manual import`, `fix(agent): keep the issue's
status out of the reply`, `docs: clarify local development`.

## Style guide

- Make the main function read as the happy path and move supporting details
  into small named helpers below it. Extract only when it names a real concept
  or makes the behavior easier to reuse, test, or reason about. Do not extract
  single-use helpers preemptively.
- Avoid `try`/`catch`. In tools, throwing is the correct way to report a
  failed call, and pi returns the error to the model.
- Avoid `any`. Rely on type inference; annotate only exports or where it aids
  clarity.
- Comment non-obvious constraints and surprising behaviour, not obvious
  assignments or control flow.
- Never alias imports; never use star imports. `type`-only imports use
  `import type`.
- Relative imports carry an extension under `NodeNext`. Use `.ts` for new
  imports (`import { loadConfig } from "./config.ts"`).
  `rewriteRelativeImportExtensions` emits `.js` paths for compiled output, and
  existing `.js` imports also resolve.

### Optional properties

`exactOptionalPropertyTypes` is on: optional fields callers may pass as
`undefined` are declared `| undefined`, and optional request fields are spread
conditionally.

```ts
// Good
{ ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }

// Bad
{ body: opts.body && JSON.stringify(opts.body) }
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
config.mcp
config.web

// Bad
const { mcp, web } = config
```

### Variables and control flow

Prefer `const`; use ternaries or early returns instead of reassignment. Avoid
`else`. Guard clauses that throw inside `toolCheck` are the established
validation pattern.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

## Repo patterns

- I/O and host orchestration compose native Effect v4 APIs. Convert to
  Promises at SDK callbacks. Agent runs finish active tool verification before
  disposal. Queue drain deadlines must never interrupt active writes.
- Fire-and-forget async is not allowed; the queue owns run lifecycles. Event
  emitters such as the HTTP listener cannot await, so each contains its own
  fiber failures.
- Host tools use `defineTool` and `ToolRegistration` from
  `@earendil-works/pi-durable`, with TypeBox schemas (`typebox`, not zod;
  `StringEnum` from `@earendil-works/pi-ai`). Execution receives
  `(params, api, context)`; the invocation signal is `context.abortSignal`.
  Text results use `textResult(...)` with output capped by `toText`. Never
  return unbounded JSON to the model. The Durable runner checkpoints each tool
  result before the model sees it.
- The MCP server uses the official `@modelcontextprotocol/sdk` with TypeBox
  JSON Schema tool inputs. `zod` is installed only as the SDK's peer; do not
  write schemas with it.
- Server tools are tables. Each file in `packages/mcp/src/services/` declares
  its reads with `defineReads` and its writes with `defineWrites`. A table key
  is the tool's name after the service prefix, so keys are snake_case. A write
  entry has `resolve`, `write`, and `verify`. Wrap each entry in
  `resource({...})` or `action({...})` so it gets its own type inference.
- Define service behavior in those tables. A tool's name, schema, and
  description are its contract; keep them out of READMEs. Service API changes
  must match the tables and the domain skills.
- A write keeps running when its client disconnects, so it is never cut before
  its read-back.
- The server compacts service responses to the fields the agent needs, pages
  or caps lists and says so, caps text at 30 000 characters, and bounds image
  output. API keys never appear in tool output.
- A release search asks every indexer, so the server keeps one in memory for
  ten minutes and answers later reads of the same target from it, with its age
  in the result. Every write through the server drops all kept searches.
- Service HTTP goes through `jsonRequestEffect`. Each package has its own
  copy: `packages/mcp/src/http.ts` on the server and
  `packages/host/src/services/http.ts` on the host. Paths are service-relative
  (`/api/v3/...`). Host-side Seerr actions go through the Seerr gateway's
  `SeerrClient`, never through agent tools.
- Adding or renaming a host tool means updating
  `packages/host/src/agent/prompt.ts` and the relevant
  `packages/host/skills/*/SKILL.md`. Adding or renaming a server tool means
  updating its table entry and those skills in the same change. A tool
  description describes _that_ tool; claims about which other tools exist
  belong in `CAPABILITY_LINES` (`packages/host/src/agent/prompt.ts`), which is
  filtered by the run's registered tool names so such a claim cannot outlive
  its tool.
