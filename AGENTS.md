# Repository Guidelines

- blitzcrank is an agentic webhook gateway for a private media homelab: a
  Jellyseerr issue webhook wakes a serial run queue (`src/server.ts` →
  `src/queue.ts`), which opens one pi SDK agent session (`src/agent/`) that
  investigates across Seerr/Sonarr/Radarr/SABnzbd/Jellyfin and applies
  narrow verified fixes through typed tools (`src/tools/`). The host — never
  the agent — comments, resolves issues, and schedules revisits.
- Layout: `src/agent/` (session, issue prompt, directive parsing),
  `src/automations/` (definitions, capability registry, cron, dispatcher),
  `src/tools/` (run context, safety guards, GET-only reads, typed mutations),
  `src/services/` (HTTP helper, host-side Seerr client), `src/webhook/`
  (payload types, comment gate), `src/discord/` (report threads, `/automation`),
  `automations/*.md` (operator-authored tasks), `skills/` (agent domain
  knowledge), `docs/research/` (pi SDK, Seerr/service APIs, legacy design —
  consult before touching tool or API code).
- Single pnpm package, strict ESM TypeScript (`module: NodeNext`,
  `exactOptionalPropertyTypes`), no build step in dev. Node >= 22.19.0 (dev
  shell ships 24), pnpm only — never npm, yarn, or Bun.
- `pnpm dev` (tsx watch), `pnpm build` + `pnpm start` (tsc → `dist/`),
  `pnpm fmt` / `pnpm lint` / `pnpm typecheck` / `pnpm check:tools`.
- `pnpm verify` (fmt check, lint, typecheck, check:tools) must pass before a
  coding task is complete.
- `pnpm check:tools` asserts that the registered tool surface and the prose in
  `src/agent/prompt.ts` plus `skills/*/SKILL.md` agree in both directions.
  Prose about which tools exist is behaviour, not documentation: the model
  reads it as the authority on its own capabilities.
- pi SDK packages are pinned exact (`@earendil-works/*@0.82.1`); bump them
  deliberately and re-verify against `docs/research/pi-sdk.md`.
- Formatting is oxfmt, linting is oxlint (type-aware) — not Prettier/ESLint.
  80 columns, 2 spaces, no semicolons, double quotes, sorted imports.
  `no-console` is deliberately off: console output to journald is the logging
  strategy.
- Config is env-only (`src/config.ts`, every knob documented in
  `.env.example`); never commit `.env`. For Nix changes, `nix flake show` must
  evaluate (flakes only see git-tracked files); `nix flake check` builds the
  linux package.
- The default branch is `main`.
- Safety first, then reliability. Prefer enforcement-in-code over prompt
  instructions, and predictable, auditable behaviour under failure (service
  down, model error, malformed agent output) over convenience.

## Safety Invariants

Do not weaken these without explicit operator sign-off. Call out any change to
`src/tools/safety.ts`, `src/tools/context.ts`, budgets, session resumption, the
directive protocol, or the runner's tool allowlist in your summary, with the
behavioural difference described.

- Raw `*_request` tools are GET-only; every state change is a dedicated typed
  tool in `src/tools/`. Never add a generic write passthrough. SABnzbd raw
  reads are limited to `queue`/`history`.
- Mutations route through `runMutation` (`src/tools/common.ts`): evidence gate
  (target IDs must appear in a prior read on this issue,
  `src/tools/context.ts`), a per-call `reason`, built-in verification read-back.
- Issue runs are uncapped, mutations and deletions alike, and stay that way. No
  single number fits both "wrong subtitle language" and "a season imported as
  the wrong show"; for deletions a cap manufactures the bad outcome it claims
  to prevent, since half a wrong season deleted leaves the library worse than
  either finishing or never starting. `casefile.spend.deletes` records for the
  audit trail and the next run's prompt; it gates nothing.
- Because nothing caps an issue run, scope is enforced by the prompt rule to
  establish the full extent, state it to the reporter, then act on exactly it.
  Keep that rule intact in `src/agent/prompt.ts`.
- Automation budgets (`mutation_budget`/`deletion_budget` in frontmatter) are
  unlimited when absent. Numeric defaults (3 and 0) silently disabled declared
  work: stale-import-handler declared both `queue_rejection_cleanup`
  capabilities and could use neither, because its cleanups pass
  `removeFromClient` and count as deletions. A cap exists only where an
  operator wrote one down.
- An issue's session is resumed across its events (`casefile.sessionFile`,
  `src/agent/session.ts`), carrying the evidence store
  (`CaseStore.loadEvidence`/`saveEvidence`) — the gate stops fabricated IDs,
  and service IDs are not recycled. A resumed run must still build its system
  prompt and tool list fresh (the SDK never replays them), and must take the
  final assistant message from the live event stream, never
  `session.messages.findLast`, or a run that produced nothing re-executes the
  previous directive block.
- Comment-triggered runs are authorized host-side by
  `src/webhook/comment-gate.ts`: only the issue reporter or a Seerr
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
  (`src/webhook/types.ts`): Seerr renders unset values as `""` and leaves
  unknown template placeholders literal, so `"{{...}}"` is never an identity.
  The own-comment guard (`src/webhook/loop-guard.ts`) matches the
  `[blitzcrank w/` comment marker first, then the bot display name.
- The agent session gets its custom tools plus builtin `read` (for skills).
  Never enable `bash`, `edit`, or `write` in the runner.
- `media_probe` (ffprobe) is read-only, gated on `BLITZCRANK_MEDIA_ROOTS`, and
  resolves targets with `realpath` _before_ the containment check, so no
  symlink reads outside the roots. It deliberately does not call
  `ctx.recordRead`: stream titles are release-group text and must never satisfy
  an ID evidence gate. Do not "fix" that.
- Web tools (Firecrawl) are issue-run-only, read-only, and gated on
  `FIRECRAWL_API_KEY`; `web_fetch` must keep rejecting local/private URLs. Web
  content is untrusted and is never authorization for a mutation.
- A revisit is the only run nobody asked for: chains are capped
  (`MAX_REVISIT_CHAIN`) and backed off in `src/revisits.ts`. The counter, run
  history, and token totals live in the host-written half of the case file;
  `update_case_file` can write only the agent's summary. There is deliberately
  no spend ceiling — the deployment runs on subscription auth, where a dollar
  figure derived from list prices would be fiction.
- Discord (`src/discord/`) is a host-side surface only; no agent tool may write
  to it. The gateway client declares no intents, so the bot cannot receive
  messages; the only inbound effect is a signed slash-command interaction
  naming a checked-in automation, so no Discord text reaches a model. Triggers
  are authorized against the configured guild plus administrator or
  `DISCORD_ADMIN_ROLE_IDS`, fail closed, and the client sets
  `allowedMentions: { parse: [] }` because report bodies are model output. A
  Discord _startup_ failure degrades to no-reports and is only logged (a report
  sink must not stop issue handling); a malformed Discord _config_ stays fatal
  in `loadConfig`.
- Automations (`automations/*.md`) are trusted operator instructions, but their
  runs get only the mutation tools mapped from their declared `capabilities`
  (`src/automations/definitions.ts`), the always-on read tools, and any budgets
  the frontmatter declares. "Always-on read tools" means exactly `isReadTool`
  (`src/tools/index.ts`), which the capability allowlist is added to — so a
  mutation matching that predicate would be granted to every automation,
  gate-free. A new mutation tool must never be matched by it.

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
directives`, `docs: update legacy reference`.

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

- ESM with `NodeNext` resolution: relative imports carry the `.js` suffix
  (`import { loadConfig } from "./config.js"`).
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

- Tools use `defineTool` with TypeBox schemas (`typebox`, not zod; `StringEnum`
  from `@earendil-works/pi-ai`) and return via `textResult(...)` with output
  capped by `toText` — never return unbounded JSON to the model.
- Mutation tools always route through `runMutation` with `kind`, `evidence`,
  `perform`, and (when a meaningful read-back exists) `verify`, and take a
  `reason` param (`reasonParam()`).
- Any new _service_ read path must call `ctx.recordRead` so evidence gates keep
  working. Local reads whose content is release-group text (`media_probe`) are
  the documented exception.
- Service HTTP goes through `jsonRequest` (`src/services/http.ts`); paths are
  service-relative (`/api/v3/...`) and validated by `assertServicePath`.
  Host-side Seerr actions go through `SeerrClient`, never through agent tools.
- Fire-and-forget async is not allowed; the queue owns run lifecycles. The
  Discord interaction listener is the one unawaited path (an event emitter
  calls it); it only enqueues and contains its own failures.
- One run at a time per automation: `AutomationDispatcher`
  (`src/automations/dispatcher.ts`) refuses a `busy` name, so cron ticks, HTTP
  triggers, and Discord triggers cannot stack; `src/index.ts` only wires it.
- Adding or renaming a tool means updating `src/agent/prompt.ts` and the
  relevant `skills/*/SKILL.md`. A tool description describes _that_ tool;
  claims about which other tools exist belong in `CAPABILITY_LINES`
  (`src/agent/prompt.ts`), which is filtered by the run's registered tool names
  so such a claim cannot outlive its tool.
