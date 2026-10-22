# blitzcrank

blitzcrank is an agent for a private media homelab. A Seerr issue webhook or a
Discord or Fluxer message starts a Pi Durable run that investigates across
Seerr, Sonarr, Radarr, SABnzbd, and Jellyfin, applies narrow verified fixes,
and replies on the issue or in the thread.

Safety comes first, then reliability. Enforce rules in code, not in the prompt.
Do not reintroduce removed runtimes, plan/apply writes, per-run tool subsets,
or compatibility paths unless the operator asks.

`packages/host` holds the gateways and the agent loop. `packages/mcp` is an MCP
server with one tool per service read or write, plus `media_probe` and
`media_frames`. They run as two processes and share no code. The MCP tool list
is the whole interface between them.

## Development

- Use Node 24 and pnpm, not npm, Yarn, or Bun. Run commands inside
  `devenv shell`, for example `devenv shell -- pnpm verify`.
- Run `pnpm verify` before completing code changes. There is no test suite.
- Config is env-only. Document host and gateway knobs in
  `packages/host/.env.example` and server knobs in `packages/mcp/README.md`.
  Never add a built-in model fallback.
- The `@earendil-works/*` packages are pinned exact. Before a bump, check the
  installed SDK API, recovery, and compaction behavior.
- For Nix changes, run `nix flake check`. Flakes only see git-tracked files.

## Invariants

Do not weaken these without operator sign-off. Call out any change to
`packages/host/src/agent/session.ts`, how the host takes the reply from a run,
the runner's tool allowlist, or which server tools a run gets.

- A thread never has two runs at once, and nothing a run writes is keyed wider
  than its thread. Every run answers a gateway event. Nothing runs on a timer.
- Tool replay defaults to unsafe. Declare `replay: "safe"` only when repeating
  the call cannot duplicate a write or a post. A server tool is safe only when
  it sets `readOnlyHint`. Recovery fails closed on a changed tool policy or an
  uncertain unsafe call.
- The reply is the run's final message, read from that submission's answer ID,
  never from the last assistant entry in history. The host posts it, and no
  other model output reaches a thread, except the name the helper model gives
  a chat thread when it opens. One run shows at most one message, and
  neither the agent nor the host closes a thread.
- Only `packages/host/src/index.ts` imports from a gateway. The runner reaches
  a thread through its `Channel`, and only `Channel.brief` describes a gateway
  to the model. Skills describe services, never a gateway.
- A gateway checks the sender before admission and before any model sees the
  message, and again when recovery resumes it. The check fails closed when the
  gateway's platform is unreachable and has no opt-out.
- The host holds no media mounts and no service credential beyond what a
  gateway needs to reach its own platform. Never enable `bash`, `edit`, or
  `write` in the runner.
- Every run gets every server tool, unloaded until `tool_search` loads it.
- A server write is one call that resolves its target against live state,
  writes, and reads the result back. A service rejection is an error result. A
  write whose outcome never came back is a JSON-RPC error, which stops the run
  for review. A client disconnect never cuts a write before its read-back.
- Media tools resolve paths with `realpath` before the containment check and
  never read from the network.

## Code

- Declare server tools in the `defineReads` and `defineWrites` tables under
  `packages/mcp/src/services/`. Host tools use `defineTool`. Schemas are
  TypeBox, never zod.
- Adding or renaming a tool means updating the domain skills in
  `packages/host/skills/` in the same change, and
  `packages/host/src/agent/prompt.ts` for a host tool.
- Cap every tool result. API keys never appear in tool output.
- Compose I/O with Effect v4 and convert to Promises at SDK callbacks. No
  fire-and-forget async. The queue owns run lifecycles.
- Avoid `try`/`catch`, `any`, `else`, reassignment, and needless destructuring.
  A tool reports failure by throwing.
- Never alias or star-import. New relative imports use the `.ts` extension.
- Under `exactOptionalPropertyTypes`, spread optional request fields
  conditionally instead of passing `undefined`.

## Git

Branch names are at most three hyphenated words with no slashes or type
prefixes, such as `fix-loop-guard`. Commits and PR titles follow
`type(scope): summary` with types `feat`, `fix`, `docs`, `chore`, and
`refactor`.
