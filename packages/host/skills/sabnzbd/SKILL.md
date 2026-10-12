---
name: sabnzbd
description: Diagnose SABnzbd downloads, post-processing, and Arr handoff. Load for stalled or failed jobs, missing downloads, and import waits.
---

# SABnzbd

Load the tools you need with `tool_search`, then call them directly. The
server adds the credentials and JSON output; never pass either.

- `sabnzbd_queue` and `sabnzbd_history` take `limit`, `start`, `search`,
  `category`, and `nzoIds`. `sabnzbd_history` also takes `failedOnly`.
- `sabnzbd_warnings` lists server-level errors such as a full disk or a
  failing news server. `sabnzbd_categories` shows which categories exist.
  `sabnzbd_server_stats` and `sabnzbd_version` take no params.

Arr owns release suitability, blocklisting, replacement, import, and rename.
Prefer Arr remediation for tracked releases. SAB completion proves neither
Arr import nor Jellyfin playback.

## Diagnosis

Match Arr queue/history download ID to the SAB job's `nzo_id` and read that job
with `nzoIds`. Compare release and category; titles are weaker evidence. Check
status, progress/ETA, age, priority, global/job pause, storage path, and
errors. Distinguish downloading from verification, repair, extraction, moving,
completion, and failure. Compare reads before calling CPU/disk-heavy work
stalled.

For language questions, probe the exact completed storage path. If Arr says
files are not ready, correlate that storage path with the Arr queue item's
output path by download ID. Check category, import errors, path mapping,
permissions, and unfinished post-processing. Never infer paths from titles or
redownload valid data that is inaccessible or still processing.

## Remediation

Use job writes only for accidental pauses, failures whose cause is fixed, or
orphans. Never delete a job Arr awaits without handling Arr state.

A write acts on its first call and takes the job's `nzoId`. It reads the job
first, so a job that is not in the named list fails with nothing written. The
result names the job's title, category, status, and storage path in `effects`,
lists `warnings`, and re-reads the list as `verification`. Read the job
yourself first and check that it is the one you mean. `verificationError`
means the write ran and only the read-back failed.

- `sabnzbd_retry_job` requires a fixed cause and a still-appropriate payload.
  Identify PAR/CRC, password, archive, permission, or space errors first.
  Retry cannot repair missing articles or irreparable archives. Preserve
  failed history until Arr can observe and blocklist it.
- `sabnzbd_delete_job` takes `from` (`queue` or `history`) and `deleteFiles`.
  Use it only for confirmed orphans in the correct list. Compare IDs,
  category, title, and submitter. Never delete Arr's expected copy. Set
  `deleteFiles: true` only for intended, justified data destruction.
- `sabnzbd_pause_job` needs a concrete downloader reason. Use
  `sabnzbd_resume_job` only when owning Arr state remains consistent. Respect
  intentional schedules and global pauses.
- `sabnzbd_change_category` (`category`) and `sabnzbd_set_priority`
  (`priority`: `low`, `normal`, `high`, or `force`) are for a job in the wrong
  category or stuck behind unrelated work. An Arr tracks only jobs in its own
  category, so moving a job it submitted can hide the job from it. Read
  `sabnzbd_categories` and the category of that Arr's other jobs first.

While repair, unpack, or post-processing progresses, wait. Do not force/manual
import, remove, blocklist, retry, search, or refresh. After completion, verify
Arr import and Jellyfin availability.
