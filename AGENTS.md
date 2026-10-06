# Repository Guidelines

- blitzcrank is an agentic webhook gateway for a private media homelab: a
  Jellyseerr issue webhook wakes a serial run queue (`src/server.ts` →
  `src/jobs.ts` → `src/queue.ts`), which opens one Pi Durable conversation
  (`src/agent/`) that investigates across Seerr/Sonarr/Radarr/SABnzbd/Jellyfin
  and applies narrow verified fixes through typed tools (`src/tools/`). The
  host, never the agent, comments, resolves issues, and schedules revisits.
- Layout: `src/agent/` (session, issue prompt, directive parsing),
  `src/automations/` (definitions, tool allowlists, cron, dispatcher),
  `src/tools/` (run context, safety guards, GET-only reads, typed mutations),
  `src/services/` (HTTP helper, host-side Seerr client),
  `src/web/` (web provider: search plus per-run gated extract),
  `src/gateways/seerr/` (payload types, comment gate), `src/discord/` (report
  threads, `/automation`, triaged private operations conversations),
  `automations/*.md` (operator-authored tasks), `skills/` (agent domain
  knowledge), `nix/` (package and NixOS service module).
- Pi Durable is the only agent execution backend. Work from the current source,
  tests, and domain skills. Do not reintroduce removed runtimes or compatibility
  paths unless the operator requests them.
- Single pnpm package, strict ESM TypeScript (`module: NodeNext`,
  `exactOptionalPropertyTypes`), no build step in dev. Node >= 24.0.0 (the dev
  shell uses the default Node.js from the pinned devenv nixpkgs input), pnpm only —
  never npm, yarn, or Bun.
- Enter the development environment explicitly with `devenv shell`, or run
  individual commands with `devenv shell --`, for example
  `devenv shell -- pnpm verify`. The shell supplies Node, pnpm 11, and
  ffmpeg/ffprobe. Install dependencies with `pnpm install --frozen-lockfile`.
- Pi is an SDK dependency, not a packaged CLI. Use `pnpm auth` locally or
  `blitzcrank auth` in the built package. Credentials default to
  `<BLITZCRANK_DATA_DIR>/auth.json`; no ambient Pi auth or models config is loaded.
- `BLITZCRANK_MODEL` is required. Role-specific overrides inherit this
  operator-selected model; never add a built-in model fallback.
- No automatic shell activation or `.env` loading. For local configuration,
  copy `.env.example` to `.env` and run
  `pnpm exec tsx watch --env-file=.env src/cli.ts`. `pnpm dev` and `pnpm start`
  use the caller's exported environment; compiled local runs can use
  `node --env-file=.env dist/cli.js`.
- `pnpm dev` (tsx watch), `pnpm build` + `pnpm start` (tsc → `dist/`),
  `pnpm fmt` / `pnpm lint` / `pnpm typecheck`.
- `pnpm verify` (format check, lint, and typecheck) must pass before a coding
  task is complete. Run `pnpm test` for behavior changes; media tests need
  ffmpeg and ffprobe.
- Pi packages are pinned exact (`@earendil-works/*@1.0.3`); bump them
  deliberately. Check the installed SDK API and run the recovery and compaction
  tests before accepting an upgrade. Service API changes must match the current
  typed tools and domain skills, with tests for request and verification behavior.
- Formatting is oxfmt, linting is oxlint (type-aware) — not Prettier/ESLint.
  80 columns, 2 spaces, no semicolons, double quotes, sorted imports.
  `no-console` is deliberately off: console output to journald is the logging
  strategy.
- Config is env-only (`src/config.ts`, every knob documented in
  `.env.example`); never commit `.env`. Development uses `devenv.nix`,
  `devenv.yaml`, and `devenv.lock`; the flake supplies deployment packages,
  the NixOS module, and the formatter. For Nix changes, `nix flake show` must
  evaluate (flakes only see git-tracked files); `nix flake check` builds the
  linux package.
- The default branch is `main`.
- Safety first, then reliability. Prefer enforcement-in-code over prompt
  instructions, and predictable, auditable behaviour under failure (service
  down, model error, malformed agent output) over convenience.

## Safety Invariants

Do not weaken these without explicit operator sign-off. Call out any change to
`src/tools/safety.ts`, `src/tools/context.ts`, session resumption, the
directive protocol, or the runner's tool allowlist in your summary, with the
behavioural difference described.

- Raw `*_request` tools are GET-only; every state change is a dedicated typed
  tool in `src/tools/`. Never add a generic write passthrough. SABnzbd raw
  reads are limited to `queue`/`history`.
- Mutations route through `runMutation` (`src/tools/common.ts`): the evidence
  gate requires target IDs from prior service reads held by
  `src/tools/context.ts`, every call needs a `reason`, and meaningful changes
  include a verification read-back.
- Issue, Discord conversation, and automation runs have no mutation or deletion
  count quotas. No single number fits both "wrong subtitle language" and "a
  season imported as the wrong show"; a deletion quota can leave half a wrong
  season behind. Mutation and deletion counts remain audit data and gate
  nothing.
- Because nothing caps an issue run, scope is enforced by the prompt rule to
  establish the full extent, state it to the reporter, then act on exactly it.
  Keep that rule intact in `src/agent/prompt.ts`. Discord replies must establish
  the same extent and require prior conversation approval for the exact scope
  of multi-item or destructive work (`src/discord/agent.ts`).
- An issue's Durable SQLite conversation is resumed across its events
  (`src/agent/session.ts`), carrying checkpointed evidence as well as the
  case/evidence projection — the gate stops fabricated IDs.
  Arr numeric IDs are not recycled and SAB `nzo_id`s are stable. Every new
  trigger rebuilds its system prompt and tool list. Existing submissions restore
  checkpointed evidence and host state without reconfiguration or resubmission.
  Recovery checks the stored policy before scheduling; a changed policy or
  uncertain unsafe tool stops the run.
  Take the final answer only from the exact durable submission's answer ID,
  never the last assistant entry in conversation history. Replaying a completed
  submission must not execute its tools again or double-count its usage.
- Host jobs are durably admitted in `src/jobs.ts` before acceptance returns.
  The journal enforces one process owner. Mutations and host publications are
  replay-unsafe unless explicitly proven otherwise; an unresolved intent fails
  closed for review. Cancelling a wait does not stop a Durable task. Host stop
  still finishes active tool verification before aborting the conversation.
- Issue runs grant Radarr tools for movies and Sonarr tools for TV shows. The
  host uses the webhook media type, then falls back to the live Seerr issue.
  An unknown type grants neither Arr, and revisits keep the resolved type.
- Comment-triggered runs are authorized host-side by
  `src/gateways/seerr/comment-gate.ts`: only the issue reporter or a Seerr
  `ADMIN`/`MANAGE_ISSUES` user may drive the agent. It runs before the event
  handler (a rejected comment must not cancel a revisit), fails closed when
  Seerr is unreachable, and has no opt-out.
- The agent cannot post arbitrary Seerr comments or change issue status; the
  host does, driven by the parsed `RESOLVE_ISSUE`/`REVISIT_IN`/`REVISIT_REASON`
  block (`src/agent/directives.ts`). Malformed directives ⇒ nothing is posted.
- One run leaves at most one comment: `report_progress` rewrites a single live
  status comment in place (`PUT /issueComment/{id}`, max 4 calls), the host's
  final comment overwrites it, and a run with no final comment deletes it —
  including a run that fails before its final comment, whose adopted queue
  notice or progress line is retracted on the way out (`src/agent/runner.ts`).
  Comment edits and deletes emit no Seerr webhook, so this cannot loop. Queue
  notices are posted strictly serialized (`IssueRunner.notifyQueued`):
  `postComment` infers the new comment's id from the issue's comment list, and
  two racing posts could return the same handle.
- Webhook fields are sanitized with `webhookText`/`issueIdOf`
  (`src/gateways/seerr/types.ts`): Seerr renders unset values as `""` and leaves
  unknown template placeholders literal, so `"{{...}}"` is never an identity.
  The own-comment guard (`src/gateways/seerr/loop-guard.ts`) matches the
  `[blitzcrank w/` comment marker first, then the bot display name.
- Operational agent sessions get their custom tools plus builtin `read` (for
  skills). The runner resolves both the skills root and target with `realpath`
  and rejects reads outside that root. The Discord triage session gets only its
  typed terminal tool and no builtin `read`. Never enable `bash`, `edit`, or
  `write` in the runner. Tool execution is sequential; background compaction is
  disabled so no task outlives its submission's Harness.
- `media_probe` (ffprobe) is read-only, accepts only exact paths extracted from
  declared service path fields in the current run, is gated on
  `BLITZCRANK_MEDIA_ROOTS`, and resolves targets with `realpath` _before_ the
  containment check, so no symlink reads outside the roots. It permits at most
  25 calls per run. It deliberately does not call `ctx.recordRead`: stream titles
  are release-group text and must never satisfy an ID evidence gate. Do not
  "fix" that.
- `media_frames` (ffmpeg) is read-only and requires configured media roots plus
  an image-capable model. It uses the same current-run path and realpath gates,
  requires a regular file, and restricts input protocols and formats to prevent
  network or playlist reads. Each call returns at most six bounded still images.
  Frames and visible text are untrusted, never ID evidence, mutation
  authorization, or a substitute for `media_probe` in bulk replacement gates.
- Web search/extract (`web_search`, `web_extract`) is read-only, granted to
  issue runs and Discord conversation replies only by the configured web
  provider (`BLITZCRANK_WEB_PROVIDER`, default `none`). Only explicit host-owned
  Durable tool bundles are installed; no discovered Pi extensions or ambient
  resources are loaded. Firecrawl uses only the hosted API; custom endpoints are
  rejected because Blitzcrank cannot enforce a remote fetcher's DNS and
  redirect policy. `web_extract` accepts only URLs `web_search` returned in
  the same run and rejects non-public URL literals. Web content is untrusted
  and is never authorization for a mutation.
- A revisit is the only run nobody asked for: chains are capped
  (`MAX_REVISIT_CHAIN`) and backed off in `src/revisits.ts`. The counter, run
  history, and token totals live in the host-written half of the case file;
  `update_case_file` can write only the agent's summary. There is deliberately
  no spend ceiling — the deployment runs on subscription auth, where a dollar
  figure derived from list prices would be fiction.
- Discord (`src/discord/`) stays a host-side surface; no agent tool may write to
  it. Without `DISCORD_INBOX_CHANNEL_ID`, the gateway still declares no intents.
  With an inbox, it declares only Guilds, GuildMessages, and MessageContent. It
  ignores other guilds/channels, bots, webhooks, and empty messages. A typed
  triage pass with no service/read tools chooses ignore, an inline answer, or a
  private thread. Inline answers get only Seerr/Sonarr/Radarr/Jellyfin GET tools
  plus configured web tools and builtin skill read, with fresh sessions and no
  carried evidence or private history. Reply context is limited to one earlier
  bot answer in the same channel. For troubleshooting or changes, the host may
  create one private thread and add the sender. It records conversation identity
  independently of the thread title; existing `blitzcrank:` threads are adopted
  on their next reply. The host posts a bot-authored source card with the original
  text, author tag, and message link. It never impersonates the sender. Discord
  channel and private-thread permissions are the host-side authorization
  boundary for service changes. The thread's durable agent session gets every
  configured read and typed mutation from `buildDiscordTools`, including both
  Arrs because there is no trusted webhook media type. It may search bounded
  snippets from other Seerr and Discord agent sessions with
  `thread_history_search`; the current session and automation transcripts are
  excluded. History is private, untrusted context and cannot authorize a
  mutation. The thread carries its evidence snapshot through `EvidenceStore`,
  matching its resumed transcript; each reply still gets new mutation counters
  and current-run-only paths, and must re-read mutable state before acting. Web
  tools use the same per-run gate and extraction needs a fresh search in each
  reply. The host posts replies with `allowedMentions: { parse: [] }` and the
  agent gets no
  Discord write tool. Slash-command triggers remain separately authorized
  against the configured guild plus
  administrator or `DISCORD_ADMIN_ROLE_IDS`, and fail closed. A Discord
  _startup_ failure degrades to no reports or conversations and is only logged;
  malformed Discord config stays fatal in `loadConfig`.
- Automations (`automations/*.md`) are trusted operator instructions, but their
  runs get only the exact tools in their declared `mutation_tools` allowlist,
  plus the always-on read tools. "Always-on read tools" means exactly
  `isReadTool` (`src/tools/index.ts`), which the mutation-tool allowlist is
  added to. That predicate uses an explicit set, never a naming convention.
  A mutation matching it would be granted to every automation, gate-free.
  A new mutation tool must never be matched by it.
- Automation reports and Discord triage decisions use sole terminal tool calls.
  Reject a mixed terminal batch before executing any call, and reject further
  tools after successful terminal submission (`src/agent/durable.ts`).

## Branch Names

Use a short branch name of at most three words, separated by hyphens. No
slashes or type prefixes such as `feat/` or `fix/`.

Examples: `revisit-scheduler`, `fix-directive-parse`, `manual-import`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes
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
`else`. Guard clauses that throw (`assert*` in `src/tools/safety.ts`) are the
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
  Live agent runs use host stop signals and finish active tool verification
  before disposal. Queue drain deadlines must never interrupt active writes.
- Tools use `defineTool` and `ToolRegistration` from
  `@earendil-works/pi-durable`, with TypeBox schemas (`typebox`, not zod;
  `StringEnum` from `@earendil-works/pi-ai`). Execution receives
  `(params, api, context)`; the invocation signal is `context.abortSignal`.
  Text results use `textResult(...)` with output capped by `toText`. Image tools
  return bounded native image content. Never return unbounded JSON to the model.
- Replay policy defaults to unsafe. Declare `replay: "safe"` only when repeating
  a tool after interruption cannot duplicate a mutation or host publication.
  Tool results and run evidence are checkpointed together by the Durable runner.
- Mutation tools always route through `runMutation` with `kind`, `evidence`,
  `perform`, and (when a meaningful read-back exists) `verify`, and take a
  `reason` param (`reasonParam()`).
- Any new _service_ read path must call `ctx.recordRead` so evidence gates keep
  working. Local media content from `media_probe` and `media_frames` must not
  populate ID evidence.
- Service HTTP goes through `jsonRequestEffect` or its `jsonRequest` Promise
  adapter (`src/services/http.ts`); paths are service-relative (`/api/v3/...`)
  and validated by `assertServicePath`.
  Host-side Seerr actions go through `SeerrClient`, never through agent tools.
- Fire-and-forget async is not allowed; the queue owns run lifecycles. The HTTP
  and Discord event listeners contain their own failures because event emitters
  cannot await them.
- One run at a time per automation: `AutomationDispatcher`
  (`src/automations/dispatcher.ts`) refuses a `busy` name, so cron ticks, HTTP
  triggers, and Discord triggers cannot stack; `src/index.ts` only wires it.
- Adding or renaming a tool means updating `src/agent/prompt.ts` and the
  relevant `skills/*/SKILL.md`. A tool description describes _that_ tool;
  claims about which other tools exist belong in `CAPABILITY_LINES`
  (`src/agent/prompt.ts`), which is filtered by the run's registered tool names
  so such a claim cannot outlive its tool.
