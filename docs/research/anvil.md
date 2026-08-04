# Anvil control-surface research

Snapshot: [`zekurio/anvil` at `f6629c3`][snapshot], verified against upstream
`main` on 2026-08-04. Anvil has no tags, releases, or changelog, so the commit
is the compatibility reference; package version `0.1.0` and API version `v1`
do not identify this interface precisely.

[snapshot]: https://github.com/zekurio/anvil/tree/f6629c3e930111b68761aeb2722f54680912a6b2

## Boundary

`anvild` owns configuration, the SQLite store, scanning, workers, and
publication. `anvilctl` is the stable operator interface and talks to the
running daemon over its Unix control socket. blitzcrank must never open the
store directly.

The upstream contract consists of:

- `anvilctl` command syntax;
- `--json` response shapes;
- API and protocol versions;
- structured errors and exit status.

The socket protocol itself is private. blitzcrank therefore invokes only
`anvilctl`, with `--socket`, `--timeout 15s`, and `--json` before the command.

Authoritative upstream sources:

- [README operating surface][operating]
- [CLI parser][cli]
- [job-list and status types][types]
- [job-show types][show-types]
- [retry and stale-lease lifecycle][lifecycle] and [job-slug generation][slugs]
- [checkpoint reuse][resume] and [worker publish recovery][worker]
- [scanner completion tracking][scanner]

[operating]: https://github.com/zekurio/anvil/blob/f6629c3e930111b68761aeb2722f54680912a6b2/README.md#operating
[cli]: https://github.com/zekurio/anvil/blob/f6629c3e930111b68761aeb2722f54680912a6b2/cmd/anvilctl/main.go
[types]: https://github.com/zekurio/anvil/blob/f6629c3e930111b68761aeb2722f54680912a6b2/pkg/control/types.go
[show-types]: https://github.com/zekurio/anvil/blob/f6629c3e930111b68761aeb2722f54680912a6b2/pkg/control/types_job_detail.go
[lifecycle]: https://github.com/zekurio/anvil/blob/f6629c3e930111b68761aeb2722f54680912a6b2/pkg/store/sqlite_job_lifecycle.go
[slugs]: https://github.com/zekurio/anvil/blob/f6629c3e930111b68761aeb2722f54680912a6b2/pkg/store/job_slugs.go
[resume]: https://github.com/zekurio/anvil/blob/f6629c3e930111b68761aeb2722f54680912a6b2/pkg/worker/resume.go
[worker]: https://github.com/zekurio/anvil/blob/f6629c3e930111b68761aeb2722f54680912a6b2/pkg/worker/worker.go
[scanner]: https://github.com/zekurio/anvil/blob/f6629c3e930111b68761aeb2722f54680912a6b2/pkg/scanner/filesystem_linux.go

## Flat CLI migration

Commit [`c5d6855`][flat] removed the noun/verb command tree and old aliases in
favour of flat, systemctl-style verbs:

| Operation   | Removed form       | Current form |
| ----------- | ------------------ | ------------ |
| List jobs   | `job list`         | `jobs`       |
| Show a job  | `job show JOB`     | `show JOB`   |
| Retry a job | `job retry JOB`    | `retry JOB`  |
| Prune       | `job prune`        | `prune`      |
| Recover     | `job recover`      | `recover`    |
| Scan        | `library scan`     | `scan`       |
| Stats       | `library stats`    | `stats`      |
| Force work  | `occurrence force` | `requeue`    |
| Backup      | `store backup`     | `backup`     |

[flat]: https://github.com/zekurio/anvil/commit/c5d6855d06bc2fd5666ded9278dae44106e68754

`status` and all global flags are unchanged. Relevant `jobs` selectors remain
`--library`, `--state`, `--path`, `--absolute-path`, `--current-only`,
`--limit`, and `--with-selection`.

This breaking syntax change did **not** bump `api_version` from `v1`, protocol
version `1`, or package version `0.1.0`. A pre-flatten client accepts `jobs` and
`retry` as aliases but needs `job show`; the current client accepts only
`show`. blitzcrank uses the flat verbs and temporarily falls back from `show`
to `job show` only for the old client's exact exit-2 `unknown command "show"`
error. Other exit-2 usage or daemon errors do not activate the fallback. No
mutation has a compatibility retry path.

## JSON and exit contract

Every successful response is a top-level JSON object carrying
`api_version: "v1"`; there is no `data` envelope. Exit status remains:

- `0`: success;
- `1`: command or daemon failure;
- `2`: usage or invalid argument;
- `3`: daemon unavailable or protocol mismatch;
- `4`: job, library, or path not found.

blitzcrank preserves the distinction between 3 (the control plane could not
answer) and 4 (the named object was not found).

`jobs` returns `server_time`, `matched`, `truncated`, and `jobs`. An exact
absolute-path query can additionally return `path_outside_libraries`, which
means the lookup is unanswerable under current roots; a historical job from a
reconfigured library may still own the path. Each job contains source/asset
occurrence state, lease and heartbeat timestamps,
destination and publish state, and optional `matched_on` and stream selection.
`matched_on` is an array drawn from source, asset, destination, and destination
directory because an in-place output can occupy several sides at once.

A broad listing is bounded. Unnarrowed upstream `jobs` defaults to 20;
blitzcrank sends an explicit limit (default 200, maximum 500). `truncated: true`
or blitzcrank's own 30,000-character result cap makes the listing incomplete.
Such a result can never prove even snapshot absence. A complete result can say
only that no matching job is present at that moment, not that one cannot be
created later. Callers should narrow with `states`; exact lookups remain the
primary correlation path. blitzcrank also requires the complete lookup path to
have been extracted verbatim from a declared path field in a service or Anvil
response during the current run, so an unrelated text field or returned parent
directory cannot authorize a reconstructed child path. Typed paths are not
carried across runs because filenames can be reused.

Stream selection on list/lookup is current-only. In a normal language-filter
decision, `missing_languages` records requested languages absent from the
source. `cleanup_disabled` can omit that computation, and no current match does
not disprove a historical show record.

Job identities are recorded separately from raw JSON evidence. Immutable
numeric IDs are carried across issue runs. Slugs have a finite namespace and
may be reused after pruning, so they are current-run aliases only and are
canonicalized to the numeric ID observed beside them. Thus numeric job `1`
cannot be authorized by an unrelated generation/attempt count, and an old slug
cannot resolve newly created work.

## Job-show additions and compaction

Since blitzcrank's previous integration, `show` added:

- `pipeline_context.search_metric` and `search_xpsnr` for XPSNR quality search;
- `publish_operation.cleanup_entries` with path and size;
- `publish_operation.cleanup_directories` for package directory cleanup.

Read `search_metric` before interpreting a score: XPSNR is not VMAF and may be
zero or negative. Upstream omits a numeric zero from JSON; blitzcrank restores
`search_xpsnr: 0` only for a completed, non-skipped XPSNR search with a CRF. A missing metric with
`search_vmaf` is a legacy VMAF checkpoint. Cleanup fields are journaled
publication intent, not evidence that a path still exists.

Anvil permits a show response up to 64 MiB because it includes every event and
payload. blitzcrank accepts that response, records it through the bounded Anvil
evidence store, and returns a deterministic compact view to the model:

- current job and every attempt's state/error first when the compact output fits;
- pipeline, publication, and stream-selection data;
- failed blocks, failed staging cleanup, and process/payload diagnostics;
- bounded samples plus omission counts for unreadable payloads;
- totals plus a bounded sample for very large cleanup manifests.

Diagnostics have their own rendered-size budget. If even the compact core does
not fit pi's result cap, the tool returns `output_complete: false`, recent
bounded attempt summaries, and an explicit no-retry conclusion; the mutation
tool enforces that conclusion.

## Retry semantics

Named `retry JOB` is a single-job mutation. blitzcrank never exposes the bulk
`--failed` form. The job reference must be a recorded immutable numeric ID or a
current-run slug paired with that ID; the mutation is recorded and
evidence-gated through `runMutation`, is subject
to any declared automation budget, and is verified with `show`.

The daemon accepts named retries from `failed`, `skipped`, `canceled`, and
`retrying` when the occurrence remains active. It rejects pending, leased,
running, validating, and replacing jobs, including one whose lease has
expired. `retrying` is already recovery in progress and must not be manually
requeued. For an expired lease in leased/running/validating/replacing, Anvil's
scheduler normally moves the job to pending when attempts remain, failed at the
attempt limit, or skipped when its source/asset occurrence is no longer current
and active. A persistent expired lease or persistent retrying state is an
operator recovery problem; blitzcrank does not expose `recover`.

blitzcrank deliberately restricts retry to a diagnosed transient `failed` job.
The tool re-reads and enforces that state plus a complete diagnostic history
before spending the mutation. Canceled jobs are operator-only: a canceled
publish conflict may already have written a destination or left backup/cleanup
residue, so reporter text is not sufficient approval to resume it.

A retry does not necessarily repeat every prior step. The interrupted encode
starts over, while valid probe, audio-cleanup, crop-detect, and CRF-search
checkpoints can be reused. A journaled publish can also resume without another
encode. Attempt history is preserved.

## Scanner timing

Current Anvil is Linux-only and uses inotify close-write and moved-in signals
to mark completed download files immediately. A later write invalidates the
mark. Files discovered after a restart or without a completion mark still use
the configured stability window.

This reduces the gap between SAB completion and job creation but does not make
an empty exact-path lookup proof of absence: event handling, scan scheduling,
new source generations, pruning, and configuration boundaries still create
legitimate misses. A complete active-state listing is the required snapshot
cross-check, not proof that no job will be created later.

## Deliberately unexposed operations

Current `anvilctl` also supports cancellation, queue recovery, pruning,
library scans, occurrence requeue, staging cleanup, store backup, and stats.
blitzcrank keeps cancellation and all library/store maintenance operator-only.
The only Anvil mutation exposed to an agent remains one evidence-gated named
retry. Read tools remain explicitly enumerated in `src/tools/index.ts`; the
`anvil_` prefix must never become an automation read allowlist.
