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

## Source paths, not destination paths

Anvil indexes jobs by the **source** path it reads, not by the converted file it writes. A lookup against an output/converted path (for example a `converted/` tree) returns zero jobs with no error, no matter how many jobs are running. When output roots are configured, `anvil_job_lookup` rejects such paths outright; when they are not, a wrong path is silently indistinguishable from "no job".

Never construct or guess a path from a title, release name, or basename. If no exact source path is available, use `anvil_job_list` or skip Anvil correlation and rely on Arr/SAB evidence.

## Zero results are unknown, not absence

A zero-result lookup means only that no job is indexed under that exact source path. The item may not be queued yet, the path may be the destination side, or the source generation may differ. `anvil_job_lookup` therefore returns an explicit `conclusion: UNKNOWN` for empty results.

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
