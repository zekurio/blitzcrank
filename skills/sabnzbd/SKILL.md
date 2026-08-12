---
name: sabnzbd
description: Diagnose and safely remediate SABnzbd queue, history, download, repair, unpack, post-processing, and Arr handoff failures. Load when a Sonarr or Radarr job is stalled, failed, missing after grab, or waiting on downloader state.
---

# SABnzbd

`sabnzbd_request` is read-only and accepts `purpose` plus relative GET paths
limited to `GET /api?mode=queue` and `GET /api?mode=history` (optional `limit`).
Blitzcrank injects credentials and JSON output; never include credentials.
Mutations use only typed tools, require `reason` and an `nzoId` previously read
as `nzo_id` on this issue, and return `verification` that must be inspected.
Issue runs are uncapped; an automation is capped only when its definition
declares a budget.

SAB downloads, verifies, repairs, unpacks, and writes output. Completion does
not prove Arr import or Jellyfin playback. Arr owns release suitability,
blocklisting, replacement, import, and rename, so prefer Arr-level remediation
while it tracks the release.

## Diagnose

1. Read Arr queue/history for exact `downloadId`, title/release, and category.
2. Read SAB queue/history (`GET /api?mode=history&limit=20` when enough) and
   match Arr `downloadId` to SAB `nzo_id`; title matching is weaker.
3. Record status, progress/ETA, age, priority, global/job pause, category,
   `storage`, and errors. Distinguish queued/downloading/paused from
   verify/repair/extract/move, complete, and failed. Compare repeated reads
   before calling CPU/disk-heavy work stalled.
4. Use API evidence—not claimed filesystem access—for server/articles,
   schedules, limits, disk thresholds, permissions, and post-processing.
5. Return to Arr to classify downloader, import, or release failure. Apply the
   narrowest action and verify it. Never delete a job Arr still awaits unless
   its Arr state is also handled.

For file-language questions, exact completed `storage` can feed `media_probe`.

## Typed mutations

- `sabnzbd_retry_job`: retry failed history only after the cause is fixed and
  the same payload remains appropriate; verify it entered queue.
- `sabnzbd_delete_job`: specify verified `nzoId`, `from: "queue"|"history"`,
  and explicit `deleteFiles`. `true` destructively deletes downloaded data and
  records a deletion. Verify absence from the selected list.
- `sabnzbd_pause_job` / `sabnzbd_resume_job`: affect one verified queue job;
  verify queue state. Pause only for a concrete downloader reason and resume
  only when owning Arr state remains consistent.

No global pause/resume, priority, category, or arbitrary-history mutation is
exposed. Downloader tools suit an accidentally paused job, a corrected retry,
or an orphan no Arr tracks. Arr removal with blocklisting/client removal is
preferred for tracked releases because it preserves release policy and cleans
SAB consistently.

## Safety decisions

Respect intentional schedules/global pauses. Retry cannot repair missing
articles or irreparable archives; identify PAR/CRC/password/archive,
permission, or space evidence first. Preserve failed history until Arr can
observe and blocklist it.

For complete-but-missing media, compare category/storage with Arr import/path
mapping; do not redownload a valid payload that is inaccessible. For
duplicates/orphans, compare IDs, category, title, and submitter; never delete
the copy Arr expects. Delete only a confirmed orphan from the correct list,
with `deleteFiles: true` solely when data destruction is intended and justified.

Call `report_progress` first with one short public status line; updates rewrite
it rather than narrating percentages. Claim mutation only after successful
verification. Never call Seerr comment/resolve APIs. Use the required final directive block
beginning with `RESOLVE_ISSUE: yes|no`; active work may add `REVISIT_IN` and a
falsifiable `REVISIT_REASON`. Keep the issue open while downloading, repairing,
importing, scanning, or awaiting verification.
