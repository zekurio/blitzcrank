---
name: sabnzbd
description: Diagnose SABnzbd downloads, post-processing, and Arr handoff. Load for stalled or failed jobs, missing downloads, and import waits.
---

# SABnzbd

Read `GET /api?mode=queue` or `GET /api?mode=history&limit=20` through
`sabnzbd_request`. Blitzcrank injects credentials and JSON output; never
include credentials.

Arr owns release suitability, blocklisting, replacement, import, and rename.
Prefer Arr remediation for tracked releases. SAB completion proves neither
Arr import nor Jellyfin playback.

## Diagnosis

Match Arr queue/history `downloadId` to SAB `nzo_id`. Compare release and
category; titles are weaker evidence. Check status, progress/ETA, age,
priority, global/job pause, `storage`, and errors. Distinguish downloading
from verification, repair, extraction, moving, completion, and failure.
Compare reads before calling CPU/disk-heavy work stalled.

For language questions, probe the exact completed `storage` path. If Arr says
files are not ready, correlate `storage` with Arr `outputPath` by download ID.
Check category, import errors, path mapping, permissions, and unfinished
post-processing. Never infer paths from titles or redownload valid data that
is inaccessible or still processing.

## Remediation

Use job writes only for accidental pauses, failures whose cause is fixed, or
orphans. Never delete a job Arr awaits without handling Arr state.

- Retry (`mode=retry&value={nzo_id}`) requires a fixed cause and a
  still-appropriate payload. Identify PAR/CRC, password, archive, permission, or
  space errors first. Retry cannot repair missing articles or irreparable
  archives. Preserve failed history until Arr can observe and blocklist it.
- Use `sabnzbd_delete_job` only for confirmed orphans in the correct list. Compare IDs, category, title, and submitter. Never delete Arr's expected
  copy. Set `deleteFiles=true` only for intended, justified data destruction.
- Pause (`mode=queue&name=pause&value={nzo_id}`) needs a concrete downloader
  reason. Resume (`name=resume`) only when owning Arr state remains consistent.
  Respect intentional schedules and global pauses; server-wide pause and
  resume are refused.

After a job write, re-read the queue or history to confirm the job's state.

While repair, unpack, or post-processing progresses, wait. Do not force/manual
import, remove, blocklist, retry, search, or refresh. After completion, verify
Arr import and Jellyfin availability.
