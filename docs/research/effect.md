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

## Further slices

Stack each subsequent PR on the preceding migration branch while it is
unmerged; use main once its parent has merged. Each slice must run on its
own and preserve the repository's safety invariants.

1. Migrate service/tool composition and persistence, moving the Promise
   adapters outward as callers become Effects. Keep evidence gates and the
   completed-write/failed-verification distinction.
2. Scope pi sessions and runner cleanup. Preserve session/evidence
   continuity, fresh prompts and allowlists, live-stream final messages,
   and the one-comment lifecycle. Issue stop requests must still wait for
   active tools before aborting the session and must retain usage/evidence.
3. Migrate queue ownership, revisits, automation scheduling, and shutdown.
   Keep serialized runs, persisted revisit plans, chain limits, and an
   explicit grace policy for in-flight mutations.

These are boundaries for future PRs, not implementations included in the
first slice. Pure parsers and TypeBox tool schemas need no conversion.

## References

Checked against the installed rc.112 source, especially `Effect.ts`,
`internal/effect.ts`, `Data.ts`, and `testing/TestClock.ts`.

- [Effect v4 source and release status](https://github.com/Effect-TS/effect)
- [Promise adapters and cancellation](https://effect.website/docs/v4/api/effect/Effect/)
- [Published Effect versions](https://registry.npmjs.org/-/package/effect/dist-tags)
