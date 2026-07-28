---
name: sabnzbd
description: Diagnose and safely remediate SABnzbd queue, history, download, repair, unpack, post-processing, and Arr handoff failures. Load when a Sonarr or Radarr job is stalled, failed, missing after grab, or waiting on downloader or Anvil state.
---

# SABnzbd

Use read-only `sabnzbd_request` with `purpose` and a relative `path`. It remains restricted to `GET /api?mode=queue` and `GET /api?mode=history`, with optional `limit`; Blitzcrank injects `apikey` and `output=json`, so never include credentials. State changes use only the dedicated typed SABnzbd tools below. Each mutation requires a `reason`, and its `nzo_id` must first appear in a queue or history read during the current run. The tool layer enforces a maximum of 5 mutations and 2 deletions per run; inspect every mutation result's `verification` field.

## Terminology

- **Job / download ID**: One NZB and its stable correlation key (`nzo_id`) used by Sonarr/Radarr.
- **Queue / history**: Downloading or waiting jobs versus post-processing/completed/failed jobs.
- **Verifying/repairing/extracting/moving**: CPU/disk-heavy stages that may legitimately take time.
- **Completed**: SAB processing ended; Arr import and Jellyfin availability remain separate.
- **Category/storage**: Routing and output path evidence used by Arr and, when exact, Anvil correlation.

## How it fits the stack

1. Sonarr/Radarr chooses media and submits an NZB.
2. SAB downloads, verifies, repairs, unpacks, and writes completed output.
3. Anvil may encode that output before Sonarr/Radarr can import it.
4. The Arr owns release suitability, blocklisting, replacement search, import, and rename.
5. Prefer remediation through the owning Arr when it still tracks the item; use typed SAB tools only for downloader-level problems.

## Common reads

- Queue: `GET /api?mode=queue`
- History: `GET /api?mode=history&limit=20`
- Prefer narrow limits; fetch full queue/history only when necessary.
- Use `anvil_status` for daemon health and `anvil_job_lookup` for exact item correlation when configured.

## Diagnostic workflow

1. Start with Sonarr/Radarr queue or history and capture exact download ID, title, release, and category.
2. Search SAB queue and history, matching Arr `downloadId` to SAB `nzo_id` whenever possible; title/NZB matching is weaker.
3. Record status, percentage, remaining time, age, priority, global/job pause evidence, category, `storage`, and failure message.
4. Distinguish downloading, queued, paused, verifying, repairing, extracting, moving, completed, and failed.
5. Compare repeated reads before calling slow work stalled. `report_progress` is single-use, so do not use it for repeated state updates.
6. Use service evidence for server errors, missing articles, scheduling, limits, disk thresholds, permissions, and post-processing failures; do not claim direct filesystem inspection.
7. Return to the Arr to see whether it recognized completion/failure and whether the issue is downloader-side, import-side, or release-side.
8. If SAB is complete but Arr says files are not ready, call `anvil_job_lookup` only with exact SAB `storage` linked to the Arr download ID, or exact Arr `outputPath`. Health alone is not item evidence.
9. Apply the smallest targeted action and inspect the returned `verification` field. Never delete a SAB job that an Arr is still waiting on unless the Arr side is also handled.

## Allowed typed mutations

Every call below requires a `reason`, and the `nzoId` must match an `nzo_id` fetched with `sabnzbd_request` this run.

- Retry a failed history job: call `sabnzbd_retry_job` with the verified `nzoId`. The tool moves it back to the queue and verifies by reading the queue. Retry only after the failure's cause is fixed, such as disk space being freed.
- Remove a job: call `sabnzbd_delete_job` with the verified `nzoId`, `from` set to `"queue"` or `"history"`, and explicit `deleteFiles`. With `deleteFiles: true`, downloaded data is also deleted and the deletion budget applies. Verification re-reads the selected list.
- Pause one queue job: call `sabnzbd_pause_job` with the verified `nzoId`; verification reads the queue.
- Resume one queue job: call `sabnzbd_resume_job` with the verified `nzoId`; verification reads the queue.

No typed tools are exposed for global pause/resume, priority, category, or arbitrary history changes. Prefer Arr-level remediation whenever Sonarr or Radarr still tracks the item: deleting an Arr queue item with blocklisting and client removal also cleans up the SAB job and preserves release-level policy. Use SAB mutations for downloader-level problems such as a job paused by accident, a failed job worth retrying after its cause is fixed, or an orphaned job no Arr tracks.

## Playbooks

### Queued, paused, or apparently stalled

Read global and job state, priority, scheduling, server/connection errors, limits, disk evidence, and progress over time. Respect intentional global pauses and schedule policy. If one queue job was paused by accident and the owning Arr remains consistent with resuming it, call `sabnzbd_resume_job` and check queue verification. Pause a single job only for a concrete downloader-level reason; no reprioritization tool is exposed.

### Verification, repair, unpack, or post-processing failure

Identify the exact stage and message. Distinguish measurable progress from failure. Report missing PAR blocks, CRC damage, password protection, unsupported archives, permissions, or space evidence. Prefer letting the Arr consume a release failure and choose another release. Retry with `sabnzbd_retry_job` only when the job is in failed history, the cause has been fixed, and retrying the same payload is appropriate; then check that queue verification finds it.

### Completed but absent from library

Record exact category and `storage`, then inspect Arr queue/history. A recognizable payload, path mapping, permissions, naming, category, Anvil encoding, and import status are separate questions. Do not recommend redownload when a valid payload is merely inaccessible or still encoding.

### Failed job blocking replacement

Preserve history evidence so the Arr can observe and blocklist the failure. Verify ID/category correlation and report whether automatic replacement occurred. If the Arr still tracks or is waiting on the job, handle removal through the Arr with the appropriate blocklist/client-removal policy. Use `sabnzbd_delete_job` only when the Arr side is also handled or no Arr tracks the job, and check verification against the correct queue or history list.

### Duplicate or orphaned job

Compare IDs, titles, categories, and submitting application, and identify which job the Arr tracks. Do not delete a duplicate that an Arr still expects. For a confirmed orphan that no Arr tracks, call `sabnzbd_delete_job` from the correct list; use `deleteFiles: true` only when deleting its downloaded data is intended and justified, then check verification.

## Anvil rules

A completed SAB item may still be encoding. Only exact active `anvil_job_lookup` evidence plus Arr file-not-ready evidence establishes a wait. For such a wait, do not trigger Arr manual/force import, removal, blocklisting, retry, search, or refresh. Failed/skipped Anvil work is a concrete blocker; complete still requires Arr/Jellyfin validation.

## Verification and communication

- Call `report_progress` exactly once as the first action, with one short public, user-facing progress sentence; do not include internal tool names, IDs, URLs, or promises.
- Claim a SAB mutation only when the typed tool succeeds and its `verification` field confirms the expected state.
- Completed download does not prove Arr import or Jellyfin playback.
- Do not call Seerr comment/resolve APIs. Use final directives `RESOLVE_ISSUE: yes|no`, optionally `REVISIT_IN` and `REVISIT_REASON` for active work.

## Pitfalls

- Do not clear failed history before the Arr observes it.
- Never delete a SAB job an Arr is still waiting on unless also handling the Arr side.
- Do not confuse SAB history deletion with Arr blocklisting; prefer Arr queue deletion with blocklisting and client removal for tracked releases.
- Retrying cannot fix missing articles or irreparable archives.
- Filesystem space can differ across mounts, but no direct filesystem tool exists; report only API evidence.
- Never infer an Anvil wait from daemon health, title, release name, or guessed path.
