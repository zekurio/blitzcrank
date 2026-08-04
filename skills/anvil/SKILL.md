---
name: anvil
description: Use when Sonarr/Radarr import delays may be caused by the Anvil encoder between SABnzbd completion and Arr import.
---

# Anvil Skill

Anvil is the transcode daemon between SABnzbd completion and Arr import. Four read-only tools exist, all requiring `purpose`: `anvil_status` (daemon health and aggregate counts), `anvil_job_list` (a bounded, filterable view of current jobs), `anvil_job_lookup` (one exact absolute path), and `anvil_job_show` (a compact diagnostic history of one job). One mutation exists: `anvil_retry_job`. Daemon health never proves that a particular media item is encoding.

## Capabilities and limits

blitzcrank can read Anvil state and requeue one job. It **cannot** cancel, abort, pause, resume, or reprioritise an encode. If a reporter asks to stop or speed up a conversion, say plainly that blitzcrank cannot do it — never imply an attempt was made, and never explain the missing capability as a timing problem ("it had already finished"), which suggests a retry would work.

Anvil's operator client can do far more — cancel jobs, prune them, force occurrences, clean staging, back up the store, recover leases. None of that is exposed here, deliberately. Cancellation is a settled decision, not a gap: an encode is work already spent on someone else's behalf, and a reporter agreeing to "stop it" is not authorization to destroy it. The rest are maintenance operations whose blast radius is a whole library or the database. All of it belongs to a human at a shell. Do not describe any of it as something you could do, and do not offer to do it.

Speak about your own tools, not about the daemon. Whether Anvil itself supports an operation is not something these tools can establish, and an operator on the box has commands you do not.

## Requeueing a job

`anvil_retry_job` requeues one `failed` job by numeric id or slug. A numeric id may come from carried evidence for this issue; a slug must appear in an Anvil read in the current run because Anvil may reuse slugs after pruning. The tool always resolves a current-run slug to its paired immutable numeric id before showing or retrying the job. Canceled, active, complete, and skipped jobs are rejected. A canceled conflict may already have published a destination or left a backup/cleanup residue; inspect `publish_operation` and report it for operator review rather than retrying it.

- The interrupted encode itself starts over, but Anvil may reuse valid `probe`, `audio-cleanup`, `crop-detect`, and `crf-search` checkpoints. A journaled publish may resume without another encode. Do not claim every step restarted or that all prior work was discarded.
- Do not pass an active state to retry. Pending, leased, running, validating, and replacing are rejected; `retrying` is already recovery in progress and must not be manually requeued. Anvil normally recovers an expired lease in leased/running/validating/replacing, so re-read shortly. A persistent expired lease or persistent retrying state requires operator investigation.
- It returns the job's state afterwards; check that state rather than assuming the requeue took.
- Retrying a job whose cause is still present just fails again. If the last error names a missing tool, a full disk, or a source that disappeared, report that instead.

## When a job will not explain itself

`anvil_job_show` returns a compact diagnostic view of one job: current state, attempt states/errors, failed events, resumable pipeline checkpoints, the quality-search metric and score, the publish/cleanup operation, and recorded stream decisions. When the output is complete, every attempt state/error is present. Routine successful event payloads are omitted so the useful history fits in the tool result. `output_complete: false` means only bounded recent attempts fit: do not retry, and require operator review. Reach for show as soon as a listing reports `failed`, an expired lease, or a job running implausibly long. A listing tells you _that_ something is wrong; only the detail view tells you _what_.

In `pipeline_context`, read `search_metric` before interpreting the score: `search_vmaf` and `search_xpsnr` are different metrics, and an XPSNR score may be zero or negative. Anvil omits numeric zero from JSON, so for a completed non-skipped XPSNR search with a CRF the tool restores `search_xpsnr: 0`. A missing metric with `search_vmaf` is a legacy VMAF checkpoint from before metric labels existed. In `publish_operation`, `cleanup_entries` and `cleanup_directories` are the package residue Anvil recorded for deletion; a large manifest is summarized with total and omitted counts, never silently treated as empty.

## When the tool errors

Anvil's client distinguishes its failures, and so must you:

- **Unreachable or protocol mismatch** — the control plane is down, or the binaries disagree. This says nothing about whether anything is encoding. Report the control plane as unavailable, never as "no conversion job exists".
- **Not found** — no job, library, or path under that reference. Re-read the job list instead of guessing another id or slug.
- **Path outside the configured libraries** — `anvil_job_lookup` reports this explicitly. The path lies outside every current library root and handoff destination, so this lookup is unanswerable under the current config; a historical job from a reconfigured library may still own it. Check the path against the Arr or SABnzbd read it came from. This is not evidence of absence.

## Common reads

- Daemon health: `anvil_status` with a concise purpose such as `check whether the Anvil control API is healthy`.
- Current jobs: `anvil_job_list`, narrowed with `states` whenever possible, then filter locally. It is bounded: only a result with `truncated: false`, no `output_complete: false`, and no blitzcrank truncation marker can establish that no matching job is present in that snapshot. An incomplete list proves nothing about jobs outside it.
- Exact item lookup: `anvil_job_lookup` with the exact absolute Sonarr/Radarr queue `outputPath`, or the SABnzbd `storage` path found by matching Arr `downloadId` to SABnzbd `nzo_id`, returned in a path field this run. Paths are not carried across runs because filenames can be reused.

## Which path side matched

`anvil_job_lookup` resolves a job's **source**, **asset**, **destination**, or **destination directory**, and every match reports which side hit in `matched_on`. So the encoder's input path (SABnzbd `storage`, Arr `outputPath`) and the converted file it wrote both correlate to the same job — state the side you matched on rather than assuming a hit means "this file is being encoded from here".

Never construct or guess a path from a title, release name, or basename. If no exact path is available, use `anvil_job_list` or skip Anvil correlation and rely on Arr/SAB evidence.

## Stream selection: why a language is missing

Anvil records which audio and subtitle streams it kept and dropped, per attempt, with a reason for each. For a missing-language report, pass `includeStreamSelection` when `anvil_job_lookup` or `anvil_job_list` can find the current job; those reads use `--current-only`. If an earlier read already evidenced a historical job id/slug, use `anvil_job_show` instead. A usable selection record survives deletion of the source file, but no current match is not evidence that no historical record exists.

- In a normal language-filter decision, `missing_languages` names languages the profile **requested** that the source did not contain. That is the direct answer to "why is there no German dub": the encoder wanted it and there was nothing to keep.
- Each stream carries `kept` and a `reason`: `language_match`, `original_language`, and `unknown_as_original` are keeps; `language_not_requested`, `commentary`, `forced`, and `sdh` are drops.
- `rule` explains the whole decision: `language_filter` is the normal path, `cleanup_disabled` means nothing was dropped and may omit the `missing_languages` computation, and the `fallback_*` rules mean no stream matched the configured languages.
- A normal complete record distinguishes **"the profile never asked for that language"** from **"the profile asked and the source had none"**. Probing the converted file cannot tell those apart. With `cleanup_disabled`, no record, or `decision_error`, report the decision as unknown and probe when possible.
- A job with **no** `stream_selection` field recorded no decision — that is not the same as a decision that kept everything, and it is not evidence that nothing was dropped. A `decision_error` means the record could not be read; treat it as unknown, never as "nothing was dropped".

## Zero results are unknown, not absence

A zero-result lookup means only that no job is indexed under that exact path right now. The item may not be queued yet, the source may have a newer generation, or the job may have been pruned. Download libraries now react to close-write and moved-in completion signals, but there is still a race before the resulting job appears, and restart/backlog discovery can still wait for the stability window. `anvil_job_lookup` therefore returns an explicit `conclusion: UNKNOWN` for empty results.

- Never write "no conversion job exists / kein Konvertierungsjob zugeordnet" on the strength of empty lookups.
- Before making any statement about whether an item is encoding, cross-check with `anvil_job_list`, narrowed to the active states when that is the question. Require `truncated: false`, no `output_complete: false`, and no local truncation marker, and describe only the current snapshot — not whether a job may be created later.
- Probing a handful of arbitrary episodes and finding nothing says nothing about the rest of a season. List once instead.

## Diagnostic rules

- Call `report_progress` as the first action for the overall issue; it is one rewritable status line, not a recurring Anvil status feed.
- A SABnzbd job can be complete while Anvil is still encoding, so Sonarr/Radarr may temporarily report no importable file, a missing or unavailable path, a locked/in-use file, size changes, access/permission-like failures, or a waiting/delayed import state.
- A unique active current job is correlated. Multiple jobs count as one package only when every job shares the same library, source path, and source generation; otherwise the result is ambiguous. Never decide from a truncated result.
- Pending, leased, running, validating, replacing, and retrying are active states. Treat complete as requiring continued Arr/Jellyfin validation. Treat failed, skipped, or canceled as terminal: the job is not coming back on its own. `skipped` means no work will run, but inspect `last_error`: it may record a normal no-work decision or that the input occurrence changed or is no longer current/active. `canceled` means someone stopped it deliberately, but a canceled publish conflict may already have written a destination or backup; inspect `publish_operation`, never assume no output exists. Compare leases and heartbeats to `server_time`; an expired lease in leased/running/validating/replacing is unhealthy, but not retryable. Anvil's recovery loop normally moves it to pending, failed, or skipped; re-read shortly. A persistent expired lease or persistent retrying state is an operator-only recovery problem.
- Only exact active job evidence plus file-not-ready Arr evidence establishes an Anvil wait. For that state, do not manual import, force import, remove, blocklist, retry, search, refresh, or call Seerr resolution/comment APIs.
- `anvil_status` may explain control-plane unavailability, but its daemon or queue counts must never establish item-level waiting.
- When an issue run ends on a confirmed Anvil wait, size the revisit to an encode, not to a default hour: a `running` job with a fresh heartbeat is typically minutes from `complete`, so ask for 10-15m and re-check. Waiting an hour to look at something that finished in six minutes leaves the reporter staring at a stale status line and hands them a job that was already done.
