---
name: sabnzbd
description: Diagnose SABnzbd queue, history, download, repair, unpack, post-processing, and Arr handoff failures without mutating SABnzbd. Load when a Sonarr or Radarr job is stalled, failed, missing after grab, or waiting on downloader or Anvil state.
---

# SABnzbd

Use read-only `sabnzbd_request` with `purpose` and a relative `path`. Only `GET /api?mode=queue` and `GET /api?mode=history` are allowed, with optional `limit`; Blitzcrank injects `apikey` and `output=json`, so never include credentials. **No SABnzbd mutations are allowed**, including resume, pause, retry, delete, priority, category, or history changes.

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
5. This skill observes SAB state only and reports where the handoff is blocked.

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

## Read-only playbooks

### Queued, paused, or apparently stalled

Read global and job state, priority, scheduling, server/connection errors, limits, disk evidence, and progress over time. Report intentional pause/schedule policy rather than overriding it. Never claim to resume or reprioritize.

### Verification, repair, unpack, or post-processing failure

Identify the exact stage and message. Distinguish measurable progress from failure. Report missing PAR blocks, CRC damage, password protection, unsupported archives, permissions, or space evidence. Do not claim repair or retry; the Arr should consume failure and choose another release when appropriate.

### Completed but absent from library

Record exact category and `storage`, then inspect Arr queue/history. A recognizable payload, path mapping, permissions, naming, category, Anvil encoding, and import status are separate questions. Do not recommend redownload when a valid payload is merely inaccessible or still encoding.

### Failed job blocking replacement

Preserve history evidence so the Arr can observe and blocklist the failure. Verify ID/category correlation and report whether automatic replacement occurred. Any queue removal or targeted search must be performed through the owning Arr under its skill policy, never through SABnzbd.

### Duplicate or orphaned job

Compare IDs, titles, categories, and submitting application, and identify which job the Arr tracks. Report the likely duplicate/orphan; do not remove it from SABnzbd.

## Anvil rules

A completed SAB item may still be encoding. Only exact active `anvil_job_lookup` evidence plus Arr file-not-ready evidence establishes a wait. For such a wait, do not trigger Arr manual/force import, removal, blocklisting, retry, search, or refresh. Failed/skipped Anvil work is a concrete blocker; complete still requires Arr/Jellyfin validation.

## Verification and communication

- Call `report_progress` exactly once as the first action, with one short public, user-facing progress sentence; do not include internal tool names, IDs, URLs, or promises.
- Never claim a SAB retry, deletion, repair, resume, or other mutation was performed.
- Completed download does not prove Arr import or Jellyfin playback.
- Do not call Seerr comment/resolve APIs. Use final directives `RESOLVE_ISSUE: yes|no`, optionally `REVISIT_IN` and `REVISIT_REASON` for active work.

## Pitfalls

- Do not clear failed history before the Arr observes it.
- Do not confuse SAB history deletion with Arr blocklisting.
- Retrying cannot fix missing articles or irreparable archives.
- Filesystem space can differ across mounts, but no direct filesystem tool exists; report only API evidence.
- Never infer an Anvil wait from daemon health, title, release name, or guessed path.
