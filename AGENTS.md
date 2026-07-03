# AGENTS.md

This file gives AI agents the repo-specific context they need when working in Blitzcrank.

- The default branch in this repo is `main`.
- Use `main` or `origin/main` for diffs.
- Keep secrets out of commits; `.env*`, local SQLite databases, and built binaries are ignored or should remain untracked.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `issue-handoff`, `fix-import-loop`, `discord-health`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected area when helpful, e.g. `agent`, `automation`, `config`, `discord`, `harness`, `llm`, `store`, `tools`, `webhook`, or `nix`.

Examples: `fix(store): persist thread events`, `feat(discord): add health command`, `docs: update config example`.

## Go Skills

For Go coding, review, debugging, or setup work, use the Go skills orchestrator and load the relevant specializations before changing code. Commonly relevant skills for this repo include:

- `golang-code-style`
- `golang-context`
- `golang-design-patterns`
- `golang-error-handling`
- `golang-lint`
- `golang-project-layout`
- `golang-structs-interfaces`
- `golang-testing`

## Style Guide

### General Principles

- Keep related logic in one function unless extracting it makes the behavior easier to reuse, test, or reason about.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Keep the happy path readable and handle validation, missing resources, and errors early.
- Prefer boring, explicit Go over clever abstractions. A little copying is better than a little dependency.
- Minimize public surface area. Export only what is used across packages or is part of a deliberate package API.
- Add comments for non-obvious constraints, concurrency assumptions, protocol quirks, and surprising behavior; avoid comments that restate simple assignments or control flow.

### Go Formatting and Organization

- Use `gofmt`/`go fmt`; do not hand-format Go code.
- Keep imports grouped and let Go tooling order them.
- Avoid dot imports. Blank imports should be limited to entrypoints or tests where side effects are obvious.
- Keep related declarations together: constants, types, constructors, methods, then helpers.
- Keep helpers close to the code they support, usually below the main exported function/type that uses them.

### Variables and Data Structures

- Use `:=` for non-zero values and `var` for intentional zero-value initialization.
- Prefer `const` where possible.
- Initialize slices and maps explicitly when they may be returned, serialized, or mutated. Avoid surprising nil slices/maps.
- Preallocate slices/maps when there is a clear expected size; do not preallocate speculatively.
- Use named fields in composite literals for structs from this repo and for external structs whose shape may change.
- Reduce total variable count by inlining values that are only used once, but keep named booleans or intermediate values when they explain business logic.

### Control Flow

- Avoid unnecessary `else` after `return`, `break`, or `continue`.
- Prefer early returns for errors and edge cases.
- Prefer `switch` over long `if`/`else if` chains when comparing the same value or expressing mutually exclusive modes.
- Extract complex conditions into named booleans when the condition has multiple business rules.
- Keep synchronous parsing, validation, and option building synchronous. Do not introduce goroutines or async-style orchestration unless the operation is actually concurrent.

### Context, Cancellation, and External Calls

- Pass `context.Context` as the first parameter, named `ctx`, on operations that can block, call LLM providers, use Discord/Seerr/Jellyfin, access SQLite, run automations, or participate in shutdown.
- Do not store contexts in structs. Pass them explicitly.
- Do not create `context.Background()` in the middle of a request/job path; propagate the caller's context.
- Always call cancel functions on every control-flow path unless ownership is explicitly returned or transferred.
- External service calls should respect context cancellation and include enough metadata to diagnose failures without leaking secrets.
- Be conservative around Discord actions, Seerr/Jellyfin mutations, and scheduled automation state. Prefer explicit safety checks and clear logs over implicit behavior.

### Errors and Logging

- Returned errors must be checked; do not discard errors with `_` unless there is a documented, safe reason.
- Wrap errors with useful context using `%w`; keep error strings lowercase and without trailing punctuation.
- Errors should be either logged or returned, not both. Log at process/job boundaries where the error is handled.
- Use `errors.Is`/`errors.As` for sentinel or typed error handling.
- Use the repo's structured logging helpers for bot/operator diagnostics. Keep log messages stable and attach variable data as attributes.
- Avoid `panic` for expected operational failures. Reserve it for impossible programmer errors or startup invariants that cannot be recovered.

### Package Boundaries

- Keep the executable entrypoint in `cmd/blitzcrank` thin. Application behavior belongs under `internal/`.
- Keep prompt and tool-call construction in `internal/agent`/`internal/pi`; avoid leaking provider details through unrelated packages.
- Keep Discord gateway behavior in `internal/discord`, Seerr/Jellyfin tool behavior in `internal/tools`, and webhook handling in `internal/webhook`.
- Keep persistence concerns in `internal/store`; callers should receive explicit domain data instead of raw SQL details.
- Avoid import cycles by pushing shared concepts down into focused packages rather than creating broad utility packages.

## Testing

- Prefer table-driven tests with named subtests for behavior matrices.
- Test observable behavior and package contracts; do not duplicate production logic into tests.
- Avoid mocks unless they clarify a package boundary. Prefer real temporary directories, in-memory fixtures, and small fake implementations.
- Use `t.TempDir()` for filesystem tests and keep tests independent of execution order.
- Do not rely on real Discord, Seerr, Jellyfin, or LLM credentials in tests.

## Task Completion Requirements

### Coding Tasks

Before considering a Go coding task completed, run:

```sh
go test ./...
go build ./cmd/blitzcrank
```

Run `nix build` when packaging, flake wiring, or the NixOS module changes.

### Documentation or Planning Tasks

If the task only changes docs or plans, verification can be limited to reading the rendered/changed files unless the user asks for more. Still keep examples and commands accurate.

## Package Roles

- `cmd/blitzcrank` - executable entrypoint for the Discord bot.
- `internal/agent` - prompt construction and agent/tool-call behavior.
- `internal/automation` - scheduled Markdown automation tasks.
- `internal/cache` - local cached data helpers.
- `internal/config` - environment and TOML configuration loading.
- `internal/discord` - Discord gateway, commands, and message handling.
- `internal/harness` - issue workflow coordination.
- `internal/logging` - logging setup and helpers.
- `internal/pi` - Pi/client integration.
- `internal/store` - SQLite persistence.
- `internal/tools` - Seerr/Jellyfin/media-server tools exposed to agents.
- `internal/webhook` - Seerr webhook server.
- `skills` - agent behavior definitions.
- `automations` - scheduled Markdown jobs.
- `nix` - Nix package and module support.

## Project Snapshot

Blitzcrank is a Go Discord bot and support agent for Seerr/Jellyfin operations. It coordinates Discord, webhooks, scheduled automations, local skills, model-provider calls, and SQLite state.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Reliability first.
2. Operator trust first: diagnostics should be clear, stable, and safe to share.
3. Keep behavior predictable during webhook retries, Discord reconnects, automation runs, external service failures, and model/provider errors.
4. Avoid leaking secrets, tokens, upstream payloads, or private media metadata.

If a tradeoff is required, choose correctness, debuggability, and safe operation over short-term convenience.

## Maintainability

Long-term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module or package. Duplicate logic across multiple files is a code smell and should be avoided. Do not take shortcuts by adding local logic when a focused shared package would keep behavior consistent.
