# Repository Guidelines

This file gives AI agents the repo-specific context they need when working in
blitzcrank.

- The default branch in this repo is `main`.

## Project Overview

blitzcrank is an agentic webhook gateway for a private media homelab. Users
report issues in Jellyseerr; a webhook wakes blitzcrank, which runs a pi SDK
agent session that investigates across Sonarr/Radarr/SABnzbd/Jellyfin/Seerr,
applies narrow verified fixes, and reports back on the issue. The host process
— not the agent — owns all user-visible actions.

This is a greenfield rebuild of a battle-tested Go deployment; its design is
distilled in `docs/research/legacy.md` (the original artifacts are not in the
repo).

### Core Priorities

1. Safety first: the agent must not be able to do more than we decided it can.
2. Reliability: runs are serial, failures are contained, loops are guarded.
3. Keep behavior predictable and auditable under failures (service down, model
   errors, malformed agent output).

If a tradeoff is required, choose enforcement-in-code over prompt instructions,
and correctness over convenience. Prompts persuade; the tool layer enforces.

## Architecture & Data Flow

Single pnpm package, ESM TypeScript, no build step in dev (`tsx`).

```
Jellyseerr ──webhook──▶ src/server.ts (Hono, filtering, loop guards)
                          └▶ src/queue.ts (serial) ──▶ src/agent/runner.ts
                               case file in/out (src/casefile.ts): memory, spend, revisits
                               one pi session per run (src/agent/prompt.ts)
                               ├─ reads:    *_request tools   (GET-only)
                               ├─ mutations: typed tools       (src/tools/)
                               └─ final msg ─▶ src/agent/directives.ts
                          host executes: comment / resolve (src/services/seerr.ts)
                                         revisit scheduling (src/revisits.ts)
```

Safety invariants (do not weaken without explicit operator sign-off):

- Raw `*_request` tools are GET-only; every state change is a dedicated typed
  tool in `src/tools/`. Never add a generic write/mutation passthrough.
- Mutations go through `runMutation` (`src/tools/common.ts`): evidence gates
  (target IDs must appear in a prior read this run, `src/tools/context.ts`),
  per-run budgets, built-in verification.
- SABnzbd raw reads are limited to `queue`/`history`; SAB job control and all
  file deletions exist only as typed tools with evidence gates and budgets.
- Comment-triggered runs are authorized host-side by `src/webhook/comment-gate.ts`:
  only the issue reporter or a Seerr `ADMIN`/`MANAGE_ISSUES` user can drive the
  agent. The gate runs before the event handler (so a rejected comment cannot
  cancel a revisit) and fails closed when Seerr is unreachable. It is
  unconditional — do not add an opt-out.
- The agent cannot post arbitrary Seerr comments or change issue status; the
  host does, driven by the parsed `RESOLVE_ISSUE`/`REVISIT_IN`/`REVISIT_REASON`
  directive block. Malformed directives ⇒ nothing is posted.
- One run leaves at most one comment: `report_progress` posts a live status
  comment and rewrites it in place (`PUT /issueComment/{id}`, max 4 calls), the
  host's final comment overwrites it, and a run with no final comment deletes
  it. Comment edits/deletes emit no Seerr webhook, so this cannot loop.
- Webhook payload fields are sanitized with `webhookText`/`issueIdOf`
  (`src/webhook/types.ts`): Seerr renders unset values as `""` and leaves
  unknown template placeholders literal, so `"{{...}}"` is never an identity.
  The own-comment loop guard (`src/webhook/loop-guard.ts`) matches the
  `[blitzcrank w/` comment marker first, then the bot display name.
- The agent session gets only its custom tools plus builtin `read` (for
  skills). Never enable `bash`, `edit`, or `write` in the runner.
- `media_probe` (ffprobe) is read-only and gated on `BLITZCRANK_MEDIA_ROOTS`: targets are
  resolved with `realpath` _before_ the containment check, so no symlink can read outside
  the roots. It deliberately does **not** call `ctx.recordRead` — stream titles are
  release-group text and must never satisfy an ID evidence gate. Do not "fix" that.
- Anvil is reached only through `anvilctl` over its control socket, never by opening its
  store. Of that surface blitzcrank exposes reads plus `anvil_retry_job`. Cancellation is
  deliberately **not** exposed and should not be added: an encode is work already spent on
  someone else's behalf, and a reporter agreeing to "stop it" is not authorization to
  destroy it (see the closed issue #8). `job prune`, `job recover`, `occurrence force`,
  `staging cleanup`, and `store backup` stay operator-only for the same reason — their
  blast radius is a library or the database.
- Web tools (Firecrawl) are issue-run-only, read-only, and gated on `FIRECRAWL_API_KEY`;
  `web_fetch` must keep rejecting local/private URLs. Web content is untrusted
  and must never be presented to the model as authorization for mutations.
- Revisit chains are capped (`MAX_REVISIT_CHAIN`) and backed off in `src/revisits.ts`: a
  revisit is the only run nobody asked for. The counter, the run history and the token
  totals live in the host-written half of the case file; the `update_case_file` tool can
  only write the agent's summary, never usage or revisit state. There is deliberately no
  spend ceiling: the deployment runs on subscription auth, where a dollar figure derived
  from list prices would be fiction.
- Discord (`src/discord/`) is a host-side surface only: the host posts automation
  reports, and no agent tool may write to Discord — never add one. The gateway client
  declares **no intents**, so the bot cannot receive messages; the only inbound effect
  is a signed slash-command interaction naming a checked-in automation, so no Discord
  text ever reaches a model. Triggers are authorized against the configured guild plus
  administrator or `DISCORD_ADMIN_ROLE_IDS`, fail closed, and the client sets
  `allowedMentions: { parse: [] }` because report bodies are model output. A Discord
  _startup_ failure degrades to no-reports and is only logged, because a report sink
  must not be able to stop issue handling; a malformed Discord _config_ stays fatal in
  `loadConfig`.
- Automations (`automations/*.md`) are trusted operator instructions, but
  their runs only get the mutation tools mapped from their declared
  `capabilities` (registry in `src/automations/definitions.ts`) plus the
  always-on read tools, with per-automation budgets from frontmatter.

## Key Directories

- `src/tools/` - run context (evidence/budgets), safety guards, GET-only read tools, typed mutation tools per service, run-history search.
- `src/agent/` - pi SDK session factory, issue prompt, directive parsing.
- `src/automations/` - definition loading/validation, capability registry, cron scheduler, STATUS report parsing.
- `automations/` - operator-authored scheduled tasks; frontmatter declares schedule, capabilities, and budgets.
- `src/services/` - HTTP helper and the host-side Seerr client.
- `src/webhook/` - verified Seerr webhook payload types, comment authorization
  gate.
- `src/discord/` - automation report threads (private, one per automation), the
  `/automation` command and its bulk-overwrite registration. Host-side only.
- `skills/` - agent skills (domain knowledge, playbooks); merged from the legacy production deployment. Frontmatter `name` must match the directory.
- `docs/research/` - pi SDK integration guide, Seerr/service API references, legacy design reference. Consult before touching tool or API code.

## Development Commands

- `pnpm dev` - run with `tsx watch`.
- `pnpm fmt` / `pnpm lint` / `pnpm typecheck` - oxfmt, oxlint (type-aware), `tsc --noEmit`.
- `pnpm test` - unit tests for pure logic via Node's test runner (`tsx --test`).
- `pnpm verify` - fmt check + lint + typecheck + `check:tools` + `test`; must pass before a
  task is done.
- `pnpm check:tools` - asserts the documented tool surface matches the registered one in
  both directions. Prose about which tools exist is behaviour, not documentation: the model
  reads it as the authority on its own capabilities.
- `pnpm build` / `pnpm start` - compile to `dist/` and run.
- `nix develop` (or direnv) - dev shell with Node 24, pnpm, TypeScript.
- Config is env-only; see `.env.example`. Never commit `.env`.

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

## Code Conventions & Common Patterns

### General Principles

- Keep related logic in one function unless extracting it makes the behavior
  easier to reuse, test, or reason about.
- Do not extract single-use helpers preemptively; inline logic used once.
- Avoid `try`/`catch` where possible. In tools, throwing is the correct way to
  report a failed call — pi returns it to the model as a tool error.
- Avoid the `any` type. Rely on type inference; annotate only exports or where
  it aids clarity.
- `exactOptionalPropertyTypes` is on: optional interface fields that callers
  may pass as `undefined` must be declared `| undefined`; spread conditionals
  (`...(x !== undefined ? { x } : {})`) for optional request fields.

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

- ESM with `NodeNext` resolution: relative imports use the `.js` suffix
  (`import { loadConfig } from "./config.js"`).
- Never alias imports; never use star imports.
- `type`-only imports use `import type`.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of
reassignment.

### Control Flow

Avoid `else`; prefer early returns. Guard clauses (`assert*` functions that
throw) are the established pattern for validation — see `src/tools/safety.ts`.

### Complex Logic

Make the main function read as the happy path; move supporting details into
small named helpers below it. Extract only when it names a real concept.

### Established Patterns to Follow

- Tools: `defineTool` with TypeBox schemas (`typebox` package, not zod;
  `StringEnum` from `@earendil-works/pi-ai` for string enums). Every tool
  returns via `textResult(...)` with output capped by `toText` — never return
  unbounded JSON to the model.
- Mutation tools: always route through `runMutation` with `kind`, `evidence`,
  `perform`, and (when a meaningful read-back exists) `verify`. New mutations
  need a `reason` param (`reasonParam()`).
- Reads feed the evidence store: any new _service_ read path must call
  `ctx.recordRead` so evidence gates keep working. Local reads whose content is
  release-group text (`media_probe`) are the documented exception.
- Service HTTP goes through `jsonRequest` (`src/services/http.ts`); paths are
  service-relative (`/api/v3/...`) and validated by `assertServicePath`.
- Host-side Seerr actions go through `SeerrClient`, never through agent tools.
- Fire-and-forget async is not allowed; the queue owns run lifecycles. The Discord
  interaction listener is the one unawaited async path (an event emitter calls it); it
  only enqueues and must contain its own failures.
- One automation run at a time per automation: `AutomationDispatcher`
  (`src/automations/dispatcher.ts`) refuses a `busy` name, so cron ticks, HTTP
  triggers and Discord triggers cannot stack. It owns the in-flight set, the
  name lookup and the report hand-off; `src/index.ts` only wires it.
- Keep prompts (`src/agent/prompt.ts`) and skills consistent with the actual
  tool surface — when adding/renaming tools, update both plus the relevant
  `skills/*/SKILL.md`. `pnpm check:tools` enforces that a tool is described
  somewhere and that nothing describes a tool that does not exist.
- A tool description describes _that_ tool. Claims about which other tools exist
  belong in `CAPABILITY_LINES` (`src/agent/prompt.ts`), which is filtered by the
  run's registered tool names, so such a claim cannot outlive its tool.

## Important Files

- Entry point: `src/index.ts` (wiring, revisit re-arm on boot), `src/server.ts` (webhook
  filtering).
- Memory/limits: `src/casefile.ts` (per-issue case file), `src/revisits.ts` (chain caps,
  backoff, restart re-arm).
- Automation dispatch: `src/automations/dispatcher.ts` (one run per automation, report
  hand-off), covered by `dispatcher.test.ts`.
- Operator check: `scripts/discord-smoke.ts` validates the live Discord setup
  (permissions, threads, commands) without running an agent.
- Agent: `src/agent/runner.ts` (session per run, locked-down resource loader),
  `src/agent/directives.ts` (final-response protocol).
- Safety: `src/tools/context.ts`, `src/tools/safety.ts`, `src/tools/common.ts`.
- Config: `src/config.ts` + `.env.example` (all knobs documented there).
- Nix: `flake.nix` (dev shell, formatter).

## Runtime/Tooling Preferences

- Node >= 22.19.0 (SDK requirement; dev shell provides 24), pnpm only — never
  npm, yarn, or Bun.
- Strict ESM TypeScript, `module: NodeNext`, `tsc --noEmit` for typechecking.
- Formatting is oxfmt, linting is oxlint (type-aware) — not Prettier/ESLint.
  80-col width, 2-space indent, no semicolons, double quotes, sorted imports.
  `no-console` is deliberately off: console output to journald IS the logging
  strategy.
- pi SDK packages are pinned exact (`@earendil-works/*@0.82.1`); bump them
  deliberately and re-verify against `docs/research/pi-sdk.md`.

## Task Completion Requirements

### Coding Tasks

`pnpm verify` (fmt check, lint, typecheck) must pass before considering a
coding task completed. If you changed the tool surface, confirm prompts and
skills still match it.

### Nix Tasks

If updating the flake or dev shell, `nix flake show` must evaluate (files must
be tracked by git for flakes to see them).

### Safety-Relevant Tasks

Any change to `src/tools/safety.ts`, `src/tools/context.ts`, budgets, the
directive protocol, or the runner's tool allowlist must be called out
explicitly in the summary, with the behavioral difference described.
