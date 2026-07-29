---
name: anvil
description: Use when Sonarr/Radarr import delays may be caused by the Anvil encoder between SABnzbd completion and Arr import.
---

# Anvil Skill

Anvil is the transcode daemon between SABnzbd completion and Arr import. Three read-only tools exist, all requiring `purpose`: `anvil_status` (daemon health and aggregate counts), `anvil_job_list` (all current jobs in one call), and `anvil_job_lookup` (one exact absolute source path). Daemon health never proves that a particular media item is encoding.

## Capabilities and limits

blitzcrank's Anvil tools are **read-only**: status, job list, job lookup. It cannot cancel, abort, pause, resume, reprioritise, or retry an encode. If a reporter asks to stop, skip, or speed up a conversion, say plainly that blitzcrank cannot do it — never imply an attempt was made, and never explain the missing capability as a timing problem ("it had already finished"), which suggests a retry would work.

Speak about your own tools, not about the daemon. Whether Anvil itself supports an operation is not something these tools can establish, and an operator on the box has commands you do not.

## Common reads

- Daemon health: `anvil_status` with a concise purpose such as `check whether the Anvil control API is healthy`.
- All current jobs: `anvil_job_list`, then filter locally. One call, no false negatives; this is the only way to establish that an item has **no** job.
- Exact item lookup: `anvil_job_lookup` with the exact absolute Sonarr/Radarr queue `outputPath`, or the SABnzbd `storage` path found by matching Arr `downloadId` to SABnzbd `nzo_id`.

## Which path side matched

`anvil_job_lookup` resolves a job's **source**, **asset**, **destination**, or **destination directory**, and every match reports which side hit in `matched_on`. So the encoder's input path (SABnzbd `storage`, Arr `outputPath`) and the converted file it wrote both correlate to the same job — state the side you matched on rather than assuming a hit means "this file is being encoded from here".

Never construct or guess a path from a title, release name, or basename. If no exact path is available, use `anvil_job_list` or skip Anvil correlation and rely on Arr/SAB evidence.

## Stream selection: why a language is missing

Anvil records which audio and subtitle streams it kept and dropped, per attempt, with a reason for each. Pass `includeStreamSelection` to `anvil_job_lookup` or `anvil_job_list` for any missing-language report. It is the cheapest and most precise answer available, and it survives deletion of the source file.

- `missing_languages` names languages the profile **requested** that the source did not contain. That is the direct answer to "why is there no German dub": the encoder wanted it and there was nothing to keep.
- Each stream carries `kept` and a `reason`: `language_match`, `original_language`, and `unknown_as_original` are keeps; `language_not_requested`, `commentary`, `forced`, and `sdh` are drops.
- `rule` explains the whole decision: `language_filter` is the normal path, `cleanup_disabled` means nothing was dropped, and the `fallback_*` rules mean no stream matched the configured languages.
- This distinguishes **"the profile never asked for that language"** from **"the profile asked and the source had none"**. Probing the converted file cannot tell those apart; only this record can, and the difference decides whether a different release would help or a profile needs changing.
- A job with **no** `stream_selection` field recorded no decision — that is not the same as a decision that kept everything, and it is not evidence that nothing was dropped. A `decision_error` means the record could not be read; treat it as unknown, never as "nothing was dropped".

## Zero results are unknown, not absence

A zero-result lookup means only that no job is indexed under that exact path right now. The item may not be queued yet, the source may have a newer generation, or the job may have been pruned. `anvil_job_lookup` therefore returns an explicit `conclusion: UNKNOWN` for empty results.

- Never write "no conversion job exists / kein Konvertierungsjob zugeordnet" on the strength of empty lookups.
- Before making any statement about whether an item is encoding, confirm with one `anvil_job_list` call and filter the result yourself.
- Probing a handful of arbitrary episodes and finding nothing says nothing about the rest of a season. List once instead.

## Diagnostic rules

- Call `report_progress` as the first action for the overall issue; it is one rewritable status line, not a recurring Anvil status feed.
- A SABnzbd job can be complete while Anvil is still encoding, so Sonarr/Radarr may temporarily report no importable file, a missing or unavailable path, a locked/in-use file, size changes, access/permission-like failures, or a waiting/delayed import state.
- A unique active current job is correlated. Multiple jobs count as one package only when every job shares the same library, source path, and source generation; otherwise the result is ambiguous. Never decide from a truncated result.
- Pending, leased, running, validating, replacing, and retrying are active states. Treat complete as requiring continued Arr/Jellyfin validation. Treat failed, skipped, or canceled as terminal: the job is not coming back on its own. `skipped` means Anvil decided the job needed no work; `canceled` means someone stopped it deliberately, and no output was written for it. Compare leases and heartbeats to `server_time`; an expired lease is potentially stuck, not healthy waiting.
- Only exact active job evidence plus file-not-ready Arr evidence establishes an Anvil wait. For that state, do not manual import, force import, remove, blocklist, retry, search, refresh, or call Seerr resolution/comment APIs.
- `anvil_status` may explain control-plane unavailability, but its daemon or queue counts must never establish item-level waiting.
