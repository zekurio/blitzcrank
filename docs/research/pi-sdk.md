# Pi Durable runtime integration

Blitzcrank uses `@earendil-works/pi-durable@1.0.3` as its only agent execution
backend. `pi-ai`, `pi-coding-agent`, and Chord are pinned to the same release.
The coding-agent package remains for `ModelRuntime`, deployment skill loading,
and the operator's login CLI, not for `AgentSession` or JSONL execution.

Pi Durable is experimental. Exact pins and recovery tests are required even
for patch upgrades. The [original evaluation](pi-durable.md) explains the
tradeoffs behind the cutover.

## Ownership and persistence

The host keeps its native Effect orchestration and one serial operational
queue. `src/jobs.ts` persists admitted work before a trigger returns success.
It retains the payload, stable run ID, lifecycle state, and named host actions.
An exclusive lock on a separate SQLite database prevents a second service
process from owning the same state directory. The lock is released by the OS
when a process dies.

Each active run opens one Durable Harness for its conversation. The host job ID
is the submission request ID. Reopening a completed submission returns that
submission's answer; it does not execute the model or tools again. A crash
leaves accepted host work recoverable, even if its original waiter disappeared.

Storage under `BLITZCRANK_DATA_DIR`:

| Path                                              | Purpose                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `jobs.sqlite`                                     | Host admission, statuses, immutable inputs, publication intents/results |
| `jobs.sqlite.owner`                               | Single-process ownership lock                                           |
| `sessions/issues/<issueId>.sqlite`                | One conversation per issue                                              |
| `sessions/discord/<threadId>/conversation.sqlite` | One conversation per private thread                                     |
| `sessions/inline/<runId>.sqlite`                  | Isolated public reply, no private session carry                         |
| `sessions/automations/<runId>.sqlite`             | Fresh conversation per automation tick                                  |
| `cases/`, `evidence/`                             | Host case/audit and evidence projections                                |

Host and conversation databases use WAL with `synchronous = FULL`, unlike the
upstream adapter's default `NORMAL`. Back up while stopped or use a consistent
SQLite backup. Copying a live main file without its committed WAL can lose work.

There is no cross-process worker pool. Do not open a second Harness on a live
conversation file. History search uses read-only SQLite snapshots, not Harness
open or the writable Durable storage adapter.

## Session adapter

`src/agent/session.ts` accepts an explicit `storageFile` and `requestId`.
An undefined storage file uses memory, as for Discord triage. Callers supply
fresh prompts, model settings, native tools, and optional `RunContext` and
host-owned tool state.

The adapter:

- Registers only explicit host-owned tools and deployment skill read. It never
  installs `CodingTools`, discovers extensions, or loads ambient project
  instructions.
- Uses sequential tool rounds. Durable's default parallel execution is not
  appropriate for shared evidence and mutable service state.
- Compacts before context overflow without background compaction outliving the
  current submission. Native provider retries remain enabled; service writes
  still have no automatic retry.
- Associates the final answer with the exact submission. Never select the last
  assistant entry from the transcript.
- Returns durable terminal-tool details and successful-tool counts, so report
  parsing does not depend on a closure from the original process.
- Preserves token usage across compaction and recovery. OAuth/subscription
  authentication omits price estimates.
- Checkpoints evidence, audit counters, and host tool state during execution,
  rather than relying solely on the end-of-run evidence file.

Native Durable tools use `defineTool` and `ToolRegistration` from
`@earendil-works/pi-durable`. Their callback is
`execute(args, api, context)`. Cancellation is `context.abortSignal`; terminal
control is `control: { terminate: true }`. Schemas remain TypeBox and service
work remains an Effect converted to a Promise at this boundary.

## Recovery safeguards

A fresh trigger rebuilds prompts and tools. An unfinished submission must
match its recorded policy before scheduling starts. A changed model, prompt,
tool declaration, or terminal policy stops old work instead of sending an
already-prepared request under stale permissions.

Tool intent is durable before execution. Only declared replay-safe reads can
run again after interruption. Mutations, progress publication, case-summary
updates, and gated local/web tools are unsafe by default. Terminal captures
have no external effect and use replay-safe per-task cached results.
Do not classify a tool by its HTTP method: SABnzbd mutations use GET.

An unfinished unsafe tool can have changed the remote service. Blitzcrank
stops that submission for review before the model can propose a replacement
write. It does not claim remote exactly-once execution.

Safety checks belong inside execution as well as any hooks. Durable skips
`beforeTool` when resuming a stored safe execution. The terminal gate checks the
entire assistant batch before allowing any sibling and persists successful
termination.

Carried stable IDs keep their existing semantics. Reusable Anvil slugs, exact
media paths, and web extraction grants do not become permanent permissions.
Mutable state still needs fresh service reads; media probe output never supplies
ID evidence.

The issue host also checkpoints the comment handle, progress-call count, and
agent-writable case summary. Host spend and run history are projected from a
recorded baseline plus the submission's usage, so recovery cannot add the same
run twice.

## Host actions and shutdown

`JobStore.actionEffect` records intent before an unsafe Seerr/Discord action
and records its result afterward. A completed action returns its recorded
result. An intent without a result fails with `UncertainActionError`, rather
than repeating a possible successful public post. Explicitly replay-safe local
steps may rerun. Do not mark remote actions safe just to avoid this failure.

A final comment might already have replaced a progress comment when a process
dies. Once publication starts, cleanup must not delete that possible final
answer. Uncertain publication is retained for operator review.

Effect owns run lifetimes. Cancelling a Chord wait only abandons the wait;
it does not stop a task. User stop waits for active typed tools and verification,
then aborts the conversation. Shutdown stops admission and drains without
interrupting writes. If the process must exit before draining finishes, pending
journal records survive for the next owner.

Automation recovery checks its recorded definition against the current trusted
definition. Changed or removed tasks fail closed. A new tick gets a new run ID;
recovery of an interrupted tick retains its original ID and context.

Discord recovery reconstructs delivery from durable metadata and checks current
channel/thread authorization before resuming. It does not reopen a private
conversation by re-running the original inbox triage.

## Cutover and operations

Old coding-agent JSONL sessions are not imported, opened, or searched.
No old files are deleted. Issue case summaries and audit records remain; old
private-thread approvals must be restated when their transcript is unavailable.
Auth paths and the operator's `blitz-pi` / `blitzcrank-pi` login workflow remain
unchanged.

On startup, queued/running jobs recover. Cancellation requests remain durable
until cleanup finishes, and recover without model execution. Completed, failed,
and fully cancelled jobs do not automatically restart. Failed records retain
their errors, and action records distinguish completed publication from
uncertain intent.

For an uncertain action:

1. Read the logged job ID and failure.
2. Inspect the owning service or Discord/Seerr thread to establish what happened.
3. Request fresh authorized work only after reconciling the uncertain operation.
   Do not delete the intent or set the old job back to queued to force replay.

The journal contains private message payloads and case state. Give it the same
filesystem access restrictions as credentials and conversation databases.

## Upgrade checks

Run `pnpm test`, `pnpm verify`, and `pnpm build`. For dependency changes also
refresh the Nix dependency hash and run `nix flake check`.

Tests must cover real process death as well as graceful close: accepted work,
model request recovery, safe and unsafe tool checkpoints, evidence, terminal
batches, current-submission answers, publication uncertainty, cancellation,
automation busy slots, and read-only history over live WAL data.

Sources inspected:

- [Durable README](https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/README.md)
- [Durable specification](https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/docs/spec.md)
- [Tool intent and recovery](https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/src/harness/tool.ts)
- [Generation recovery](https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/src/harness/generation.ts)
- [Node SQLite adapter](https://github.com/earendil-works/pi/blob/v1.0.3/packages/durable/src/storage/sqlite/node.ts)
