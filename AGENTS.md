# Repository Guidelines

## Project Structure & Module Organization

Blitzcrank is a Go Discord bot and support agent for Jellyseerr/Jellyfin operations. The executable entrypoint lives in `cmd/blitzcrank/`. Application code is organized by responsibility under `internal/`: `agent` builds prompts and runs tool calls, `automation` schedules Markdown tasks, `config` reads environment configuration, `discord` handles gateway traffic, `harness` coordinates issue workflows, `llm` wraps model providers, `store` persists SQLite state, `tools` exposes media-server tools, and `webhook` serves Jellyseerr callbacks. Agent behavior lives in `skills/<name>/SKILL.md`; scheduled jobs live in `automations/*.md`. Nix packaging and the development shell are defined in `flake.nix`.

## Build, Test, and Development Commands

- `nix develop`: enter the pinned development shell with Go, gopls, go-tools, and sqlite.
- `go run ./cmd/blitzcrank`: run the bot locally using values from `.env`.
- `go test ./...`: run all package tests.
- `go test ./internal/store -run TestStorePersistsIssueThreadEventAndRun`: run one focused test.
- `go build ./cmd/blitzcrank`: compile the binary without running it.
- `nix build`: build the packaged application from the flake.

Copy `.env.example` to `.env` for local development. Keep secrets out of commits; `.env*` and SQLite files are ignored.

## Coding Style & Naming Conventions

Use standard Go formatting: run `gofmt` on changed `.go` files before submitting. Prefer small packages with clear ownership under `internal/`, exported names only for cross-package APIs, and table-driven tests when behavior branches. Test files use Go’s conventional `*_test.go` suffix and `TestXxx` names. Skill and automation directories/files should use lowercase kebab-case, for example `skills/seerr-issue-solver/SKILL.md` and `automations/daily-health-check.md`.

## Testing Guidelines

Add or update tests next to the package being changed. Use `t.TempDir()` for filesystem state and avoid relying on real service credentials in tests. Run `go test ./...` before opening a PR; run focused package tests while iterating. For changes to persistence or workflows, cover both the stored state and the observable behavior.
