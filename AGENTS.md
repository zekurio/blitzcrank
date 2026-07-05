# Repository Guidelines

## Project Overview

Blitzcrank is a Go Discord bot and support agent for Seerr/Jellyfin media operations. It is a thin orchestrator around an external Pi agent runtime: Blitzcrank owns Seerr webhook ingress, issue state, scheduled automations, Discord reporting, and SQLite persistence; Pi owns the LLM provider auth, model selection, tool loop, and durable sessions. The repo is an early WIP — sweeping maintainability improvements are welcome.

## Architecture & Data Flow

`cmd/blitzcrank/main.go` builds the object graph explicitly (constructor injection, no framework): config → tools registry → SQLite store → Pi runner → harness manager → webhook server → automation scheduler → optional Discord bot.

Seerr issue flow:

1. `internal/webhook/server.go` receives Seerr webhooks (auth, body limits, concurrency gating).
2. `internal/harness/harness.go` classifies/dedupes events, locks the issue, persists via `internal/store`, and builds the run prompt (`internal/harness/comments.go`).
3. `internal/pi/runner.go` spawns the Pi RPC process, injects `/skill:<name>` directives and system prompts from `.pi/`, and streams JSON events back as progress + final text.
4. Pi executes service tools defined in `.pi/extensions/blitzcrank-tools.ts` (Seerr/Jellyfin/Sonarr/Radarr/SABnzbd/Anvil, with mutation allowlists).
5. Progress comments and final Seerr comment/resolution go through `internal/tools/services.go`; issue/thread/run history lands in `internal/store`.

Issue revisits: when `seerr.revisits_enabled` is set, the agent can schedule its own follow-up on an open issue via `REVISIT_IN`/`REVISIT_REASON` directives in its final response (e.g. while a download or Anvil encode is pending); `internal/harness/revisit.go` re-runs the thread once the scheduled time passes (capped by `seerr.revisit_max` consecutive revisits without user activity) so the agent can confirm the fix, ask the reporter whether the issue can be closed, or resolve it.

Automation flow: `internal/automation/tasks.go` parses `automations/*.md` (front matter: `name`, `description`, `schedule`; body = task prompt), `scheduler.go` schedules via `robfig/cron` `ParseStandard`, runs tasks through the Pi runner, and reports optionally to Discord (`internal/discord/automation.go`, slash command `/automatisierung`).

## Key Directories

- `cmd/blitzcrank` — executable entrypoint; keep it thin, behavior lives under `internal/`. Includes a `blitzcrank pi` passthrough subcommand.
- `internal/harness` — Seerr issue workflow orchestration (classification, dedupe, prompts, finalization).
- `internal/pi` — Pi process/RPC boundary; prompt composition and skill directive injection.
- `internal/webhook` — Seerr webhook HTTP server and routing.
- `internal/automation` — Markdown automation parsing and cron scheduling.
- `internal/discord` — optional Discord automation bot (slash commands, status threads).
- `internal/store` — SQLite persistence (`modernc.org/sqlite`, pure Go); callers get domain data, not raw SQL.
- `internal/tools` — Go-side Seerr HTTP helpers (comment/update/resolve) used by harness and progress reporter.
- `internal/config` — layered config: struct-tag defaults → `.env` → TOML at `BLITZCRANK_CONFIG` → env overrides.
- `internal/logging` — slog setup (pretty handler, stdlib log redirect).
- `internal/cache` — TTL file-cache helpers.
- `.pi/` — Pi runtime assets: `system-prompts/*.md`, `skills/<name>/SKILL.md` (YAML front matter + Markdown), `extensions/blitzcrank-tools.ts` (the actual tool implementations and mutation allowlist).
- `automations/` — scheduled Markdown jobs.
- `nix/` — package (`nix/package.nix`) and NixOS module (`nix/module.nix`, `services.blitzcrank`).

## Development Commands

```sh
go run ./cmd/blitzcrank        # run locally (after: cp config.example.toml blitzcrank.toml)
go test ./...                  # test suite (CI adds -race)
go build ./cmd/blitzcrank      # build check
go vet ./... && gofmt -l .     # CI static checks
nix build                      # Nix package (run when nix/, flake, or packaging changes)
```

Completion requirement for Go coding tasks: `go test ./...` and `go build ./cmd/blitzcrank` must pass. Run `nix build` when packaging, flake wiring, or the NixOS module changes. There is no Makefile/justfile; `.envrc` (`use flake`) provides the dev shell (go, gopls, go-tools, nixfmt, sqlite).

## Code Conventions & Common Patterns

- `gofmt` formatting; no hand-formatting. Avoid dot imports. Minimize exported surface.
- Conventional commits: `type(scope): summary`; types `feat|fix|docs|chore|refactor|test`; useful scopes: `agent`, `automation`, `config`, `discord`, `harness`, `llm`, `store`, `tools`, `webhook`, `nix`. Branch names: ≤3 hyphenated words, no slashes or type prefixes (`session-recovery`, `fix-scroll-state`).
- Context: pass `ctx context.Context` first on anything that blocks, calls Pi/Discord/Seerr/Jellyfin, touches SQLite, or participates in shutdown. Never store ctx in structs; propagate the caller's context; call cancel on all paths.
- Errors: wrap with `%w`, lowercase messages, no trailing punctuation; check every returned error; `errors.Is`/`errors.As` for sentinels; log **or** return, not both — log at process/job boundaries. No `panic` for expected failures.
- Logging: structured `slog` via `internal/logging`; stable messages, variable data as attributes; never leak secrets, tokens, upstream payloads, or private media metadata (see `internal/store/json_sanitize.go` for the persistence-side scrub).
- Control flow: early returns, no needless `else`, `switch` over long if/else chains; named booleans for compound business rules. No goroutines or async orchestration unless the operation is genuinely concurrent.
- Style: boring explicit code over clever abstractions; no single-use helper extraction; named fields in composite literals; `:=` for non-zero values, `var` for intentional zero values; a little copying beats a little dependency.
- Boundaries: prompt/tool-call construction stays in `internal/pi` and `internal/harness`; Discord behavior in `internal/discord`; Seerr HTTP mutations in `internal/tools`; persistence in `internal/store`. Don't leak provider or SQL details across packages.
- Safety: be conservative around Discord actions, Seerr/Jellyfin mutations, and automation state — prefer explicit checks and clear logs over implicit behavior. Reliability and operator trust come first.

## Important Files

- `cmd/blitzcrank/main.go` — wiring, shutdown handling, `pi` passthrough.
- `internal/harness/harness.go` — core issue manager; `comments.go` — prompt build, `RESOLVE_ISSUE` parsing, final-comment validation; `progress.go` — transient Seerr progress comments.
- `internal/pi/runner.go` — Pi process spawn, env/model/session plumbing, JSON event stream parsing.
- `internal/config/config.go` + `env.go` — config schema and load precedence; `pi.go` — per-source model selection (`PiModelFor`).
- `internal/store/store.go` + `issues.go` — SQLite open/migrate and issue CRUD.
- `.pi/extensions/blitzcrank-tools.ts` — all agent-facing service tools and the mutation allowlist.
- `config.example.toml`, `.env.example` — configuration templates; `BLITZCRANK_CONFIG` points at the TOML (default `./blitzcrank.toml`).
- `flake.nix`, `nix/package.nix`, `nix/module.nix` — packaging and `services.blitzcrank` NixOS module.
- `.github/workflows/ci.yml` — gofmt check, `go vet`, build, `go test ./... -race`.

## Runtime/Tooling Preferences

- Go 1.26 (see `go.mod`). Key deps: `bwmarrin/discordgo`, `robfig/cron/v3`, `BurntSushi/toml`, `modernc.org/sqlite` (CGO-free — keep it that way).
- No LLM SDKs in Go: provider auth/config belongs to Pi, not this module. Don't add provider dependencies here.
- Nix flake is the canonical dev/deploy environment; `nixfmt` formats nix files (`nix fmt`).
- Secrets: `.env`/`EnvironmentFile`/SOPS only. `.gitignore` excludes `.env*` (except `.env.example`), `blitzcrank.toml`, `*.sqlite*`, `pi-sessions/`. Never commit any of these.
- Default branch is `main`; use `main`/`origin/main` for diffs.

## Testing & QA

- Stdlib-only tests (no testify, no mocking framework), white-box in-package, table-driven with named subtests.
- Isolation techniques already in use — follow them: `t.TempDir()` for filesystem state, `t.Setenv` for env, `httptest` servers for Seerr/HTTP fakes (`internal/harness/harness_test.go`), `:memory:`/temp-file SQLite (`internal/store/store_test.go`), manual fakes like `fakeRunner`/`fakeReporter` instead of mocks.
- Never rely on real Discord, Seerr, Jellyfin, or LLM credentials in tests. Tests must be order-independent; no build tags exist.
- Test observable behavior and public contracts; don't duplicate production logic in tests. Real fixtures are preferred — e.g. `internal/automation/tasks_test.go` parses the actual `automations/hourly-stale-import-handler.md`.
- Run targeted packages while iterating (`go test ./internal/harness/`), then the full completion checks before calling a task done.
