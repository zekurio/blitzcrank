# Develop locally

The repository is a pnpm workspace with two packages, `packages/host` and
`packages/mcp`. [devenv](https://devenv.sh) supplies Node 24, pnpm 11,
ffmpeg, and ffprobe. Without devenv, install those yourself. The flake builds
the deployment packages and isn't needed for development.

## Run both processes

Install once at the root, then run each package from its own directory with
its own `.env`, in two terminals. Start the server first, since the host
connects to it at the start of every run.

The server:

```sh
devenv shell
pnpm install --frozen-lockfile
cd packages/mcp
# Write .env with BLITZCRANK_MCP_TOKEN and the service URLs and API keys.
# README.md in this directory lists every setting.
pnpm exec tsx watch --env-file=.env src/cli.ts
```

The host:

```sh
devenv shell
cd packages/host
cp .env.example .env
# Fill in the three models, the FLUXER_* settings, the same
# BLITZCRANK_MCP_TOKEN, and BLITZCRANK_MCP_URL=http://127.0.0.1:8485/mcp.
pnpm exec tsx --env-file=.env src/cli.ts auth login openai  # OAuth only
pnpm exec tsx watch --env-file=.env src/cli.ts
```

`blitzcrank run` needs no `FLUXER_*` settings. To try a message without a
Fluxer bot, see [Run one message from a terminal](run.md).

Auth commands and the host must use the same data directory and auth path,
or the host won't find the credentials.

## Root scripts

With direnv, `direnv allow` activates the devenv shell when you `cd` into the
repository. Nothing loads `.env` for you.

The root scripts `pnpm dev`, `pnpm dev:mcp`, `pnpm start`, `pnpm start:mcp`,
and `pnpm auth` use whatever environment you exported. With that in place,
`pnpm auth login openai` signs in.

For a compiled run, `pnpm build` at the root, then
`node --env-file=.env dist/cli.js` in each package.

## Checks

```sh
devenv shell -- pnpm verify   # format, lint, typecheck
devenv shell -- pnpm build
nix flake check
```

There is no test suite. Run `pnpm verify` before finishing a change, and
`nix flake check` after touching anything under `nix/`. Flakes only see files
git tracks, so add new files before checking.

## Lockfile changes

The dependency hash in [`nix/package.nix`](../nix/package.nix) must match
`pnpm-lock.yaml`. After the lockfile changes, build once on Linux and copy
the hash Nix reports into that file.

## Rules

[AGENTS.md](../AGENTS.md) has the invariants and code rules. Read it before
changing how runs, tools, gateways, or writes work.
