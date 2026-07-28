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

This is a greenfield rebuild of a battle-tested Go deployment; the legacy
artifacts live in `.pi/` (read-only reference) and are summarized in
`docs/research/legacy-pi.md`.

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
- SABnzbd is read-only (`queue`/`history` only). Radarr movie-file deletion is
  not authorized. Both are deliberate legacy policy, not omissions.
- The agent cannot post Seerr comments or change issue status; the host does,
  driven by the parsed `RESOLVE_ISSUE`/`REVISIT_IN`/`REVISIT_REASON` directive
  block. Malformed directives ⇒ nothing is posted.
- The agent session gets only its custom tools plus builtin `read` (for
  skills). Never enable `bash`, `edit`, or `write` in the runner.

## Key Directories

- `src/tools/` - run context (evidence/budgets), safety guards, GET-only read tools, typed mutation tools per service.
- `src/agent/` - pi SDK session setup, system prompt, directive parsing.
- `src/services/` - HTTP helper and the host-side Seerr client.
- `src/webhook/` - verified Seerr webhook payload types.
- `skills/` - agent skills (domain knowledge, playbooks); merged from the legacy production deployment. Frontmatter `name` must match the directory.
- `docs/research/` - pi SDK integration guide, Seerr/service API references, legacy design reference. Consult before touching tool or API code.
- `.pi/` - legacy deployment artifacts. Reference only; never load or import from here at runtime.

## Development Commands

- `pnpm dev` - run with `tsx watch`.
- `pnpm typecheck` - `tsc --noEmit`.
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
- Reads feed the evidence store: any new read path must call `ctx.recordRead`
  so evidence gates keep working.
- Service HTTP goes through `jsonRequest` (`src/services/http.ts`); paths are
  service-relative (`/api/v3/...`) and validated by `assertServicePath`.
- Host-side Seerr actions go through `SeerrClient`, never through agent tools.
- Fire-and-forget async is not allowed; the queue owns run lifecycles.
- Keep prompts (`src/agent/prompt.ts`) and skills consistent with the actual
  tool surface — when adding/renaming tools, update both plus the relevant
  `skills/*/SKILL.md`.

## Important Files

- Entry point: `src/index.ts` (wiring), `src/server.ts` (webhook filtering).
- Agent: `src/agent/runner.ts` (session per run, locked-down resource loader),
  `src/agent/directives.ts` (final-response protocol).
- Safety: `src/tools/context.ts`, `src/tools/safety.ts`, `src/tools/common.ts`.
- Config: `src/config.ts` + `.env.example` (all knobs documented there).
- Nix: `flake.nix` (dev shell, formatter).

## Runtime/Tooling Preferences

- Node >= 22.19.0 (SDK requirement; dev shell provides 24), pnpm only — never
  npm, yarn, or Bun.
- Strict ESM TypeScript, `module: NodeNext`, `tsc --noEmit` for typechecking.
- No formatter/linter is configured yet; match the existing style (2-space
  indent, double quotes, semicolons). Adopting oxfmt/oxlint is welcome as a
  dedicated chore PR, not as a side effect.
- pi SDK packages are pinned exact (`@earendil-works/*@0.82.1`); bump them
  deliberately and re-verify against `docs/research/pi-sdk.md`.

## Testing & QA

No test suite exists yet. When adding one:

- Prefer pushing logic into pure functions and testing those with `node --test`
  via `tsx`; `directives.ts`, `context.ts`, and `safety.ts` are pure and are
  the highest-value targets.
- Avoid mocks as much as possible; never mock the safety layer to make a test
  pass.
- Test actual implementation, do not duplicate logic into tests.

## Task Completion Requirements

### Coding Tasks

`pnpm typecheck` must pass before considering a coding task completed. If you
changed the tool surface, confirm prompts and skills still match it.

### Nix Tasks

If updating the flake or dev shell, `nix flake show` must evaluate (files must
be tracked by git for flakes to see them).

### Safety-Relevant Tasks

Any change to `src/tools/safety.ts`, `src/tools/context.ts`, budgets, the
directive protocol, or the runner's tool allowlist must be called out
explicitly in the summary, with the behavioral difference described.
