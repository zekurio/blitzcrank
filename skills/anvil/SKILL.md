---
name: anvil
description: Use when Sonarr/Radarr import delays may be caused by the Anvil encoder between SABnzbd completion and Arr import.
---

# Anvil

Anvil transcodes between SABnzbd completion and Arr import. Reads require
`purpose`: `anvil_status` (health/counts), `anvil_job_list` (bounded current
jobs), `anvil_job_lookup` (one exact absolute path), and `anvil_job_show`
(compact history). The sole mutation is `anvil_retry_job`. Health or aggregate
counts never prove an item is encoding.

## Limits and retry safety

Blitzcrank can read and requeue one job. It cannot cancel, abort, pause, resume,
reprioritize, prune, recover, force occurrences, clean staging, or back up the
store. These operator-only actions can affect someone else's encode, a library,
or the database. For stop/speed-up requests, plainly state the capability is
unavailable; never imply an attempt or describe it as a timing issue. Discuss
your exposed tools, not what the daemon or shell client might support.

`anvil_retry_job` accepts a numeric ID or slug for one `failed` job. A numeric
ID may come from carried issue evidence; a slug must appear in an Anvil read in
the current run because pruning permits reuse. The tool resolves a current-run
slug to its immutable numeric ID. It rejects canceled, active, complete,
skipped, or `retrying` jobs.

Before retrying, use `anvil_job_show` and ensure the cause is gone. Missing
tools, full disks, or vanished sources need operator correction. For canceled
publish conflicts, inspect and report `publish_operation`; a destination or
cleanup residue may exist. Retry restarts the interrupted encode but can reuse
valid probe/audio-cleanup/crop-detect/CRF-search checkpoints, and a journaled
publish may resume without encoding. Never claim all work was discarded.
Inspect the returned state rather than assuming requeue succeeded.

Pending, leased, running, validating, replacing, and retrying are active.
Anvil normally recovers expired leases in leased/running/validating/replacing;
re-read shortly. Persistent expiry or `retrying` requires operator review, not
manual retry.

## Reading jobs safely

Use:

- `anvil_status` only for control-plane health.
- `anvil_job_list`, narrowed by `states`, for snapshots. Absence is established
  only with `truncated: false`, no `output_complete: false`, and no Blitzcrank
  truncation marker.
- `anvil_job_lookup` only with an exact absolute path returned by a service
  **this run**: Arr queue `outputPath`, or SAB `storage` matched by Arr
  `downloadId` = SAB `nzo_id`. Paths are not carried between runs and must
  never be constructed from a title, release, or basename.
- `anvil_job_show` for any failed, expired-lease, or implausibly long job, or an
  already evidenced historical ID/slug.

Lookup can match source, asset, destination, or destination directory; report
`matched_on` rather than assuming which side matched. Empty lookup has
`conclusion: UNKNOWN`: the job may not exist yet, may have a newer generation,
or may be pruned. Cross-check a complete active-state list before describing
only the current snapshot. Never turn an empty/incomplete lookup or a few
sampled episodes into "no conversion job exists."

A unique active current job is correlated. Multiple jobs form one package only
when all share library, source path, and source generation. Never decide from
truncated output. Exact active-job evidence **plus** Arr file-not-ready evidence
establishes an Anvil wait. During that wait, do not manual/force import, remove,
blocklist, retry, search, refresh, or call Seerr comment/resolution APIs.

`anvil_job_show` includes attempts/errors, failed events, resumable checkpoints,
quality metric/score, publish cleanup, and stream decisions. `output_complete:
false` means history was bounded: do not retry; require operator review. Read
`search_metric` before scores: XPSNR can be zero/negative, and the tool restores
omitted zero as `search_xpsnr: 0`; an unlabeled legacy checkpoint under
`search_vmaf` is VMAF. Cleanup manifests may be summarized, never presumed
empty.

Tool errors retain meaning: unreachable/protocol mismatch means only that the
control plane is unavailable; not-found requires re-listing, not guessed
references. "Path outside configured libraries" means lookup is unanswerable
under current roots (possibly historical configuration), not that no job
exists; recheck the source path.

## Stream selection

For missing-language reports, request `includeStreamSelection` on a current
`anvil_job_lookup`/`anvil_job_list`; use `anvil_job_show` for evidenced history.
A record survives source deletion, but no current match does not exclude
history.

- Under `language_filter`, `missing_languages` are requested languages absent
  from the source. `language_match`, `original_language`, and
  `unknown_as_original` keep streams; `language_not_requested`, `commentary`,
  `forced`, and `sdh` drop them.
- `cleanup_disabled` means no drop and may omit missing-language computation;
  `fallback_*` means configured languages did not match.
- A complete normal record distinguishes "not requested" from "requested but
  absent." With no record, `cleanup_disabled`, or `decision_error`, the
  decision is unknown; probe if possible. Missing `stream_selection` never
  means nothing was dropped.

## State and communication

Call `report_progress` first, as one rewritable public status line. SAB may be
complete while Anvil causes temporary missing/unavailable/locked/changing paths
or delayed imports. Complete still needs Arr/Jellyfin validation. Failed,
skipped, and canceled are terminal; inspect `last_error` and
`publish_operation` because skip may be normal/stale-input and cancellation may
leave output. Compare leases/heartbeats with `server_time`.

For a confirmed running job with a fresh heartbeat, schedule a roughly 10–15
minute revisit rather than a default hour; report only what the next check will
verify. Keep the issue open while encoding and through subsequent Arr import
and Jellyfin validation; completion of one stage is not end-to-end resolution.
