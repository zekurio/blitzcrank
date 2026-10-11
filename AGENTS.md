# Repository Guidelines

- blitzcrank is an agent for a private media homelab. A gateway turns inbound
  traffic into events on a thread; Seerr is the only gateway, and its threads
  are issues. An event wakes a serial run queue, which opens one Pi Durable
  conversation that investigates across Seerr/Sonarr/Radarr/SABnzbd/Jellyfin
  and applies narrow verified fixes. The agent's final message is the reply.
  The host, never the agent, posts it, closes threads, and arms revisits.
- It is a pnpm workspace with two packages that run as two processes.
  `packages/host` (npm name `blitzcrank`) holds the gateways and the agent
  loop: `src/server.ts` → `src/gateways/` → `src/thread-work.ts` →
  `src/jobs.ts` → `src/queue.ts` → `src/agent/`. It defines the host tools
  `update_case_file`, `thread_history_search`, `tool_search`,
  `schedule_revisit`, and optional `web_search`/`web_extract`, builds the
  gateway's close tool (`resolve_issue` for Seerr), and grants builtin `read`
  for skills.
  `packages/mcp` (npm name `@blitzcrank/mcp`, binary `blitzcrank-mcp`) is an
  MCP server. It holds the service credentials and media mounts and exposes
  one tool per read and per write, named `<service>_<what>` (`sonarr_queue`,
  `radarr_delete_movie_file`), plus `media_probe` and `media_frames`. The host
  connects to it once per run with `@earendil-works/pi-mcp`. The packages
  share no code: the MCP tool list is the whole interface between them.
- Every server tool is a Durable tool of the run, and every run can reach
  every one. They start unloaded so their schemas stay out of the prompt: the
  model loads them by name or keyword with `tool_search`, which adds them to
  the conversation through Durable's `control.addTools`. The host decides
  replay from `readOnlyHint` alone: a read is `replay: "safe"`, anything else
  keeps the unsafe default.
- A write is one call. It resolves its target against live state, writes, and
  reads the result back, returning `summary`, `effects`, `warnings`, and
  `verification`. Nothing asks the model to confirm.
- Define service behavior in `packages/mcp/src/services/`. A tool's name,
  schema, and description are its contract; keep them out of READMEs.
- Layout: `packages/host/src/gateway.ts` (the `Gateway`, `Channel`, and
  `Intake` interfaces and the gateway registry),
  `packages/host/src/gateways/seerr/` (webhook handling, channel, payload
  types, comment gate, loop guard), `packages/host/src/thread-work.ts`
  (admission, ordering, recovery), `packages/host/src/agent/` (runner,
  session, prompts), `packages/host/src/tools/` (host tools: case file,
  history, tool search, revisit and close requests),
  `packages/host/src/mcp/` (server connection, tool adapter),
  `packages/host/src/services/` (HTTP helper, host-side Seerr client),
  `packages/host/src/web/` (web provider: search and extract),
  `packages/host/skills/` (agent domain knowledge),
  `packages/mcp/src/services/` (one read table and one write table per
  service), `packages/mcp/src/media/` (ffprobe, ffmpeg, path containment),
  `nix/` (packages and NixOS service module).
- Pi Durable is the only agent execution backend and Seerr is the only
  gateway. Another source of requests is another `Gateway` listed in
  `packages/host/src/index.ts`; nothing else in the host may learn about it.
  Work from the current source and domain skills. Do not reintroduce removed
  runtimes, automations, in-process service tools, the `codemode` sandbox,
  plan/apply writes, per-run tool subsets, tools that carry the reply or
  progress text, or compatibility paths unless the operator requests them.
- pnpm workspace (`packages/*`), strict ESM TypeScript (`module: NodeNext`,
  `exactOptionalPropertyTypes`, shared `tsconfig.base.json`), no build step in
  dev. Node >= 24.0.0 (the dev shell uses the default Node.js from the pinned
  devenv nixpkgs input), pnpm only, never npm, yarn, or Bun.
- Enter the development environment explicitly with `devenv shell`, or run
  individual commands with `devenv shell --`, for example
  `devenv shell -- pnpm verify`. The shell supplies Node, pnpm 11, and
  ffmpeg/ffprobe for the server's media tools. Install dependencies with
  `pnpm install --frozen-lockfile`.
- Pi is an SDK dependency, not a packaged CLI. Use `pnpm auth` locally or
  `blitzcrank auth` in the built package. Credentials default to
  `<BLITZCRANK_DATA_DIR>/auth.json`; no ambient Pi auth or models config is loaded.
- `BLITZCRANK_MODEL`, `BLITZCRANK_MCP_URL`, and `BLITZCRANK_MCP_TOKEN` are
  required on the host; never add a built-in model fallback.
- No automatic shell activation or `.env` loading. Each package reads its own
  `.env`. For the host, copy `packages/host/.env.example` to
  `packages/host/.env`. For the server, write `packages/mcp/.env` from the
  Environment table in `packages/mcp/README.md`. Then run
  `pnpm exec tsx watch --env-file=.env src/cli.ts` inside `packages/mcp` and
  inside `packages/host`, the server first. The root scripts use the caller's
  exported environment; compiled local runs can use
  `node --env-file=.env dist/cli.js` in each package.
- Root scripts: `pnpm dev` (host, tsx watch), `pnpm dev:mcp` (server),
  `pnpm build` (`pnpm -r build`, tsc → each package's `dist/`), `pnpm start`,
  `pnpm start:mcp`, `pnpm auth`, and `pnpm fmt` / `pnpm lint` /
  `pnpm typecheck` (`pnpm -r typecheck`).
- `pnpm verify` (format check, lint, and typecheck) must pass before a coding
  task is complete. There is no test suite.
- Pi packages are pinned exact (`@earendil-works/*@1.1.0`, including
  `pi-mcp`); bump them deliberately. Check the installed SDK API, recovery,
  and compaction behavior before accepting an upgrade. Service API changes
  must match the server's read and write tables and the domain skills.
- The MCP server uses the official `@modelcontextprotocol/sdk` with TypeBox
  JSON Schema tool inputs. `zod` is installed only as the SDK's peer; do not
  write schemas with it.
- Formatting is oxfmt, linting is oxlint (type-aware) — not Prettier/ESLint.
  80 columns, 2 spaces, no semicolons, double quotes, sorted imports.
  `no-console` is deliberately off: console output to journald is the logging
  strategy.
- Config is env-only (`packages/host/src/config.ts` with every knob documented
  in `packages/host/.env.example`; `packages/mcp/src/config.ts` with every knob
  documented in `packages/mcp/README.md`); never commit `.env`. Development
  uses `devenv.nix`, `devenv.yaml`, and `devenv.lock`; the flake supplies
  deployment packages, the NixOS module, and the formatter. For Nix changes,
  `nix flake show` must evaluate (flakes only see git-tracked files);
  `nix flake check` builds the linux packages.
- The default branch is `main`.
- Safety first, then reliability. Prefer enforcement-in-code over prompt
  instructions, and predictable, auditable behaviour under failure (service
  down, model error, malformed agent output) over convenience.

## Host Invariants

Do not weaken these without explicit operator sign-off. Call out any change to
`packages/host/src/agent/session.ts`, how the reply is taken from a run, the
runner's tool allowlist, or the MCP exposure rule in your summary, with the
behavioural difference described.

- Host jobs are durably admitted in `packages/host/src/jobs.ts` before
  acceptance returns. The journal enforces one process owner. Replay defaults
  to unsafe; declare `replay: "safe"` only when repeating a tool after
  interruption cannot duplicate a write or host publication. Recovery checks
  the stored policy before scheduling; a changed policy or an uncertain unsafe
  tool fails closed for review. Take the final answer only from the exact
  durable submission's answer ID, never the last assistant entry in
  conversation history. Replaying a completed submission must not execute its
  tools again or double-count its usage.
- The Durable policy fingerprint includes the MCP tool list: every server tool
  is registered, loaded or not. A server whose tools changed between admission
  and recovery is a changed policy and fails closed for review.
- The runner reaches a thread only through its `Channel`
  (`packages/host/src/gateway.ts`). Code outside
  `packages/host/src/gateways/<name>/` imports from a gateway only in
  `packages/host/src/index.ts`, which lists them.
- The reply is the text of the run's own answer entry, and every run posts
  it, revisits included. The host, never the agent, posts it, closes threads,
  and arms revisits. `schedule_revisit` and the gateway's close tool only
  record a request in run state. The host acts on it after the reply is out,
  so a run that fails or is cancelled arms nothing and closes nothing.
- One run shows at most one message. The host posts a working line when the
  run starts, or adopts its queue notice. The reply rewrites that message in
  place, and a run that fails or ends without a message removes it
  (`packages/host/src/agent/runner.ts`). Seerr comment edits and deletes emit
  no webhook, so this cannot loop. The Seerr gateway serializes its comment
  posts: `postComment` infers the new comment's id from the issue's comment
  list, and two racing posts could return the same handle.
- Comment-triggered runs are authorized host-side by
  `packages/host/src/gateways/seerr/comment-gate.ts`: only the issue reporter
  or a Seerr `ADMIN`/`MANAGE_ISSUES` user may drive the agent. It runs before
  the event handler (a rejected comment must not cancel a revisit), fails
  closed when Seerr is unreachable, and has no opt-out.
- Webhook fields are sanitized with `webhookText`/`issueIdOf`
  (`packages/host/src/gateways/seerr/types.ts`): Seerr renders unset values as
  `""` and leaves unknown template placeholders literal, so `"{{...}}"` is
  never an identity. The own-comment guard
  (`packages/host/src/gateways/seerr/loop-guard.ts`) matches the
  `[blitzcrank w/` comment marker first, then the bot display name.
- The host holds no Sonarr, Radarr, SABnzbd, or Jellyfin credentials and no
  media mounts. Its only service credential is the Seerr key for host-side
  comments, issue status, and the comment gate. The server holds every
  credential the agent's reads and writes use, plus the media roots, and
  checks `BLITZCRANK_MCP_TOKEN` on every request.
- Issue agent sessions get the host tools, every server tool, and builtin
  `read` (for skills). The runner resolves both the skills root and target
  with `realpath` and rejects reads outside that root. Never enable `bash`,
  `edit`, or `write` in the runner. Tool execution is sequential; background
  compaction is disabled so no task outlives its submission's Harness.
- Server tools are offered only after `tool_search` loads them. Loading
  changes what the conversation offers and nothing outside it, so
  `tool_search` is `replay: "safe"`. A resumed conversation keeps the tools
  its earlier runs loaded. No run is limited to a subset of the server's
  tools.
- A read-only server tool (`readOnlyHint: true`) is `replay: "safe"`. Every
  other server tool keeps the unsafe default: a write interrupted mid-call,
  or one whose call is rejected, stops the run for review. The server rejects
  a call, rather than answering it, only when a write went out and its result
  never came back.
- A write resolves its target against live state before it writes, so a
  hallucinated ID fails with nothing written. A failed verification never
  hides a completed write.
- `media_probe` (ffprobe) and `media_frames` (ffmpeg) run on the server, are
  read-only, and require `BLITZCRANK_MEDIA_ROOTS` in the server's environment;
  both resolve targets with `realpath` _before_ the containment check, so no
  symlink reads outside the roots. `media_frames` additionally requires a
  regular file, restricts input protocols and formats to prevent network or
  playlist reads, and returns at most six bounded still images per call. Stream
  tags, frames, and visible text are untrusted.
- Web search/extract (`web_search`, `web_extract`) is read-only, granted to
  issue runs only by the configured web
  provider (`BLITZCRANK_WEB_PROVIDER`, default `none`). Only explicit host-owned
  Durable tool bundles are installed; no discovered Pi extensions or ambient
  resources are loaded. Firecrawl uses only the hosted API; custom endpoints are
  rejected because Blitzcrank cannot enforce a remote fetcher's DNS and
  redirect policy. Web content is untrusted.
- A revisit is the only run nobody asked for: chains are capped
  (`MAX_REVISIT_CHAIN`) and backed off in `packages/host/src/revisits.ts`, and
  `schedule_revisit` fails once the allowance is used up. A timer firing is an
  ordinary event on its thread. The counter, run history, and token totals
  live in the host-written half of the case file; `update_case_file` can
  write only the agent's summary. There is
  deliberately no spend ceiling. The deployment runs on subscription auth,
  where a dollar figure derived from list prices would be fiction.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. No
slashes or type prefixes such as `feat/` or `fix/`.

Examples: `revisit-scheduler`, `fix-directive-parse`, `manual-import`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, and `refactor`. Scopes
are optional; use the affected area when helpful, e.g. `tools`, `agent`,
`server`, `skills`, `nix`.

Examples: `feat(tools): add manual import`, `fix(agent): tolerate fenced
directives`, `docs: clarify local development`.

## Style Guide

### General Principles

- Keep related logic in one function unless extracting it makes the behavior
  easier to reuse, test, or reason about. Do not extract single-use helpers
  preemptively.
- Avoid `try`/`catch`. In tools, throwing is the correct way to report a failed
  call — pi returns the error to the model.
- Avoid `any`. Rely on type inference; annotate only exports or where it aids
  clarity.
- Comment non-obvious constraints and surprising behaviour, not obvious
  assignments or control flow.

### Optional Properties

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
config.seerr
config.sonarr

// Bad
const { seerr, sonarr } = config
```

### Imports

- ESM with `NodeNext` resolution: relative imports carry an extension. Use
  `.ts` for new TypeScript imports (`import { loadConfig } from "./config.ts"`).
  `rewriteRelativeImportExtensions` emits `.js` paths for compiled output;
  existing `.js` imports also resolve through NodeNext.
- Never alias imports; never use star imports. `type`-only imports use
  `import type`.

### Variables and Control Flow

Prefer `const`; use ternaries or early returns instead of reassignment. Avoid
`else`. Guard clauses that throw inside `toolCheck` are the
established validation pattern.

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

### Complex Logic

Make the main function read as the happy path and move supporting details into
small named helpers below it. Extract only when it names a real concept.

## Repo Patterns

- I/O and host orchestration compose native Effect v4 APIs. Convert to
  Promises at SDK callbacks; event emitters contain their own fiber failures.
  Agent runs finish active tool verification before disposal. Queue drain
  deadlines must never interrupt active writes.
- Host tools use `defineTool` and `ToolRegistration` from
  `@earendil-works/pi-durable`, with TypeBox schemas (`typebox`, not zod;
  `StringEnum` from `@earendil-works/pi-ai`). Execution receives
  `(params, api, context)`; the invocation signal is `context.abortSignal`.
  Text results use `textResult(...)` with output capped by `toText`. Never
  return unbounded JSON to the model.
- Replay policy defaults to unsafe. Declare `replay: "safe"` only when repeating
  a tool after interruption cannot duplicate a mutation or host publication.
  Tool results and host state are checkpointed together by the Durable runner.
- Server tools are tables. Each file in `packages/mcp/src/services/` declares
  its reads with `defineReads` and its writes with `defineWrites`. A table key
  is the tool's name after the service prefix, so keys are snake_case. A write
  entry has `resolve`, `write`, and `verify`. Wrap each entry in
  `resource({...})` or `action({...})` so it gets its own type inference. The
  helpers live in `packages/mcp/src/tools.ts`.
- A write the service rejects comes back as an error result and the run goes
  on. A write that went out and got no answer (a timeout, a dropped
  connection, a gateway 502 or 504) is answered with a JSON-RPC error, so the
  host's call rejects and the Durable run stops for review. A write keeps
  running when its client disconnects, so it is never cut before its
  read-back.
- The server compacts service responses to the fields the agent needs, pages
  or caps lists and says so, caps text at 30 000 characters, and bounds image
  output. API keys never appear in tool output.
- Service HTTP goes through `jsonRequestEffect`. Each package has its own
  copy: `packages/mcp/src/http.ts` on the server and
  `packages/host/src/services/http.ts` on the host. Paths are service-relative
  (`/api/v3/...`). Host-side Seerr actions go through the Seerr gateway's
  `SeerrClient`, never through agent tools.
- Fire-and-forget async is not allowed; the queue owns run lifecycles. The HTTP
  listener contains its own failures because event emitters cannot await them.
- Adding or renaming a host tool means updating
  `packages/host/src/agent/prompt.ts` and the relevant
  `packages/host/skills/*/SKILL.md`. Adding or renaming a server tool means
  updating its table entry and those skills in the same change. A tool
  description describes _that_ tool; claims about which other tools exist
  belong in `CAPABILITY_LINES` (`packages/host/src/agent/prompt.ts`), which is
  filtered by the run's registered tool names so such a claim cannot outlive
  its tool.
