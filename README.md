# Blitzcrank

Blitzcrank is a Go Discord bot and support agent for Seerr/Jellyfin operations.

## Repository Layout

- `cmd/blitzcrank/`: executable entrypoint.
- `internal/`: application packages for config, Discord, agent runs, tools, persistence, webhooks, and automations.
- `prompts/`: embedded system/runtime prompts.
- `skills/`: default Markdown skills loaded at runtime.
- `automations/`: default Markdown automation jobs loaded at runtime.
- `flake.nix`: package, dev shell, and NixOS module.

## Development

Use the pinned shell when possible:

```sh
nix develop
```

For local config:

```sh
cp config.example.toml blitzcrank.toml
cp .env.example .env
```

Keep runtime settings in `blitzcrank.toml`. Use `.env` only to point at a config file or make explicit local overrides. Secrets can live in TOML or env, depending on how you manage secret material.

Config load order:

1. built-in defaults
2. `.env` and process environment for bootstrap paths such as `BLITZCRANK_CONFIG`
3. `blitzcrank.toml`, or `BLITZCRANK_CONFIG`
4. `.env` and process environment overrides

Run locally:

```sh
go run ./cmd/blitzcrank
```

Useful checks:

```sh
go test ./...
go test ./internal/config
go build ./cmd/blitzcrank
```

Run a focused test while iterating:

```sh
go test ./internal/store -run TestStorePersistsIssueThreadEventAndRun
```

Format changed Go files with `gofmt`.

## Configuration Notes

The CLI does not expose config mutation. Edit TOML or inject env vars from the deployment layer.

Runtime profiles live under `[runtime.profiles.*]`:

- `default`: base LLM runtime
- `seerr`: Seerr issue workflows
- `discord`: Discord responses
- `automation`: scheduled automations
- `discord_triage`: Discord triage and summaries
- `sandbox_review`: AI review of Deno TypeScript sandbox scripts before execution

Provider values are `openai`, `openai-compatible`, `openrouter`, or `codex-oauth`. For the OpenCode-style setup, use `provider = "openai"` with `llm.openai.auth = "codex-oauth"`; Blitzcrank will route through Codex OAuth while applying Codex-specific model limits.

Service diagnostics are routed through `sandbox_run_typescript`, a Deno sandbox tool. It runs short TypeScript snippets with `--no-prompt` and only the network, environment, and read permissions granted by the `sandbox_review` model. Configure the Deno binary and timeout with `[sandbox] deno_path` and `timeout`, or `SANDBOX_DENO_PATH` and `SANDBOX_TIMEOUT`.

Codex OAuth helper commands are still available:

```sh
go run ./cmd/blitzcrank codex login
go run ./cmd/blitzcrank codex status
go run ./cmd/blitzcrank codex logout
```

## Runtime State

SQLite state is stored at `storage.database_path`. Disk-backed caches use `storage.cache_dir` when set and otherwise fall back to the operating system user cache directory.

JSONL traces are written under `runtime.threads_dir`:

- `issues/issue-<id>.jsonl`
- `discord/<thread-id>.jsonl`
- `discord/interactions/<message-id>.jsonl`
- `automations/<name>.jsonl`

Durable agent memories are Markdown files with frontmatter under `runtime.memories_dir`, grouped by top-level scope such as `automation/`, `discord_user/`, `seerr_issue/`, `seerr_movie/`, `seerr_show/`, and `general/`.

Prompts are embedded at build time. Skills and automations are runtime inputs and default to `skills/` and `automations/` in source-tree runs.

## Deployment

Set service credentials through TOML, `.env`, a systemd `EnvironmentFile`, SOPS, or the process environment. Do not commit secrets.

For HTTP deployments, set `web.listen_addr`. Existing Seerr webhook deployments can keep using `seerr.webhook_listen_addr`; when that legacy setting is used, also provide `seerr.base_url` plus `SEERR_API_KEY`.

For Discord deployments, provide `DISCORD_TOKEN` and set `discord.channel_id`. The Discord application needs Message Content intent enabled for normal channel-message triage.

## Nix

Build the package:

```sh
nix build
```

The flake packages the binary plus default `skills/` and `automations/` under `$out/share/blitzcrank`. The wrapped binary points `BLITZCRANK_CONFIG` at a packaged TOML default so packaged runs do not depend on source-tree paths.

The flake exports `nixosModules.default` as `services.blitzcrank`. The module creates a system user, stores mutable state in `/var/lib/blitzcrank` by default, and accepts an `environmentFile` for overrides.

Use `services.blitzcrank.settings` for TOML-backed application settings. Existing convenience options such as `publicName`, `timezone`, `automations.enable`, `databasePath`, `memoriesDir`, `threadsDir`, and `runtime.*` feed generated defaults; `settings` can override or extend them. Set `services.blitzcrank.configFile` when you want to provide the whole TOML file yourself, including a file produced by SOPS or another secret manager.

Example:

```nix
services.blitzcrank = {
  enable = true;

  settings = {
    discord.channel_id = "123456789012345678";
    seerr = {
      base_url = "https://seerr.example";
      webhook_listen_addr = "127.0.0.1:8080";
    };
  };

  automations.enable = true;

  runtime.automation = {
    provider = "openrouter";
    model = "anthropic/claude-sonnet-4.6";
    reasoningEffort = "high";
  };

  runtime.seerr = {
    provider = "openai";
    model = "gpt-5.5";
    reasoningEffort = "high";
  };
};
```

For a complete TOML file managed outside the module, set:

```nix
services.blitzcrank.configFile = config.sops.secrets.blitzcrank_toml.path;
```
