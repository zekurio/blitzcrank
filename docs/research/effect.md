# Effect v4 migration

First slice: shared HTTP and `anvilctl` I/O, pinned to
`effect@4.0.0-rc.112`. The existing Promise functions execute the new
Effect-returning functions, so this slice can merge independently.

## I/O contracts

- `jsonRequestEffect` distinguishes `HttpError` for non-2xx responses,
  `HttpRequestError` for request setup or transport failures,
  `HttpResponseError` for invalid JSON, and `HttpTimeoutError` for deadlines.
  Response shapes still belong to the endpoint callers; parsing JSON is not
  schema validation.
- `execFileTextEffect` reports `ExecError`, preserving numeric exit codes,
  stderr preference, output bounds, and the existing process timeout.
- `jsonRequest` and `execFileText` remain Promise adapters. In this pinned
  v4 release, `Effect.runPromise` rejects with the original typed failure,
  preserving the `instanceof` checks for Arr HTTP 404 verification and
  Anvil exit-code handling.
- HTTP deadlines cover both fetching headers and consuming the body, use
  the Effect clock, and abort the underlying fetch. Effect interruption
  reaches both fetch and the local child process. Caller abort signals are
  combined with the Effect signal. Aborting a client does not roll back a
  remote mutation or cancel an Anvil daemon job.
- Neither adapter retries. SABnzbd mutations use GET, so the HTTP method
  alone cannot establish whether retrying is safe. Verification failure must
  continue to return the completed mutation's result without repeating it.

Only the core Effect package is needed here. Node's fetch and execFile
remain the transport implementations. Effect's optional MessagePack native
build is disabled; this slice does not use MessagePack.

## Service tool composition

The second slice moves Seerr, Sonarr, Radarr, Jellyfin, SABnzbd, and Anvil
tools onto the native Effect I/O functions. Reads, mutation gates, writes,
and verification compose as Effects; `Effect.runPromise` sits at the pi SDK
tool callbacks. Tool names, schemas, allowlists, and evidence rules stay the
same.

- `makeReadTool` accepts an Effect request and records its result as before.
- `runMutation` returns a lazy Effect. Evidence checks run before audit
  counters and the write, with no automatic retry. Failed verification,
  including a thrown parser error, preserves the completed write's result;
  fiber interruption stays interrupted.
- Synchronous guards enter the typed failure channel as `ToolError`, keeping
  their existing messages. Arr deletion verification catches only HTTP 404;
  Anvil's legacy `job show` fallback still requires the exact unknown-command
  error. Anvil retry reservations still precede the first I/O call.

SDK tool cancellation policy is unchanged: issue stop still waits for active
tools before aborting the session.

## Persistence and remaining reads

Case/evidence files and automation definitions use native Effects with typed
storage errors. Atomic writes finish through rename before an interruption
returns. Missing pause markers remain distinct from storage failures, and
unreadable case/evidence memory retains its safe fallback behavior.

Host Seerr actions and comment authorization use the native HTTP effects.
Web search/extract, media probe/frames, and history reads convert to Promises
only at their SDK tool callbacks. Frame extraction has one Effect deadline
for the entire request. Current-run path evidence, realpath containment,
search-before-extract, history exclusions, and output bounds are unchanged.

## Sessions and runtime ownership

Pi sessions, issue/automation runs, Discord conversations, HTTP handlers,
queue transitions, and startup/shutdown now compose as Effects. SDK Promise
APIs are adapted at their boundaries. Pure parsers, TypeBox schemas, and
Croner's calendar calculation stay as they are.

- Session scopes dispose SDK resources after setup or run failures. Resumed
  sessions still get fresh prompts and tool lists, carried evidence, and only
  the current run's live final answer. Active runs use host stop signals and
  finish active tool verification before aborting; fiber interruption cannot
  dispose a session in the middle of a write.
- The serial queue owns its fibers and uses one semaphore permit across all
  triggers. Webhook transitions and queue notices have separate semaphores.
  Automation busy slots are released even if the run factory throws.
- Revisit sleeps are owned fibers, canceled on replacement, pause, and
  shutdown. Their persisted plans, chain limits, and backoff are unchanged.
- Shutdown stops cron, revisits, and new queue admission, then waits for HTTP
  closure and queued runs within the existing total 30-second grace period.
  Waiting uses fiber completion rather than polling. A drain deadline never
  interrupts the underlying write. Discord stays connected while runs drain
  so their reports can still land; the process exits when grace expires.
- SDK callbacks and event emitters are the runtime boundaries. A few Promise
  adapters remain for existing test fixtures; production orchestration calls
  native Effect APIs directly. No automatic retries or new dependencies were
  added after the initial core Effect pin.

## PR stack

Each branch targets its preceding unmerged migration branch. Merge from the
bottom, then rebase and retarget the next PR onto main.

1. [#28](https://github.com/zekurio/blitzcrank/pull/28), shared I/O and errors.
2. [#29](https://github.com/zekurio/blitzcrank/pull/29), service tools.
3. [#30](https://github.com/zekurio/blitzcrank/pull/30), persistence and host Seerr.
4. [#31](https://github.com/zekurio/blitzcrank/pull/31), web and local reads.
5. [#32](https://github.com/zekurio/blitzcrank/pull/32), sessions and Discord.
6. effect-runtime, host handoffs, queue, revisits, and shutdown.

## References

Checked against the installed rc.112 source, especially `Effect.ts`,
`internal/effect.ts`, `Data.ts`, and `testing/TestClock.ts`.

- [Effect v4 source and release status](https://github.com/Effect-TS/effect)
- [Promise adapters and cancellation](https://effect.website/docs/v4/api/effect/Effect/)
- [Published Effect versions](https://registry.npmjs.org/-/package/effect/dist-tags)
