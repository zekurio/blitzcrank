---
name: sabnzbd
description: Diagnose SABnzbd downloads, post-processing, and Arr handoff. Load for stalled or failed jobs, missing downloads, and import waits.
---

# SABnzbd

Read with `sabnzbd_read` inside a `codemode` script. The server adds the
credentials and JSON output; never pass either.

```js
const queue = await tools.sabnzbd_read({ resource: "queue", limit: 20 })
const failed = await tools.sabnzbd_read({
  resource: "history",
  failedOnly: true,
  limit: 20,
})
return { queue, failed }
```

- `queue` and `history` take `limit`, `start`, `search`, `category`, and
  `nzoIds`. `history` also takes `failedOnly`.
- `warnings` lists server-level errors such as a full disk or a failing news
  server. `categories` shows which categories exist. `serverStats` and
  `version` take no params.

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

A write with an unknown outcome stops the run for operator review. A
completed write whose verification failed is still reported as completed.

Every write is two calls. In a script, call `sabnzbd_plan` with an `action` and
the job's `nzoId`, and return the plan. Planning changes nothing, and a job that
is not in the named list fails here. The plan names the job's title, category,
status, and storage path. Check them against the job you meant, then call the
`sabnzbd_apply` tool directly with the `planId`. Scripts cannot call it.

```js
return await tools.sabnzbd_plan({
  action: "retry",
  nzoId: "SABnzbd_nzo_ab12cd",
})
```

Apply fails with `plan is stale: ...` when the job left the list or changed
status, identity, category, priority, storage path, or failure reason.
Download progress alone does not invalidate a plan. Read it again and decide again. Apply re-reads the list and returns that
as `verification`. `verificationError` means the write ran and only the
read-back failed. A second apply of one `planId` returns the first outcome with
`replayed: true`. Plans end at `expiresAt` and do not survive a server restart.

- `retry` requires a fixed cause and a still-appropriate payload. Identify
  PAR/CRC, password, archive, permission, or space errors first. Retry cannot
  repair missing articles or irreparable archives. Preserve failed history
  until Arr can observe and blocklist it.
- `deleteJob` takes `from` (`queue` or `history`) and `deleteFiles`. Use it only
  for confirmed orphans in the correct list. Compare IDs, category, title, and
  submitter. Never delete Arr's expected copy. Set `deleteFiles: true` only for
  intended, justified data destruction.
- `pause` needs a concrete downloader reason. `resume` only when owning Arr
  state remains consistent. Respect intentional schedules and global pauses.
- `changeCategory` (`category`) and `setPriority` (`priority`: `low`, `normal`,
  `high`, or `force`) are for a job in
  the wrong category or stuck behind unrelated work. An Arr tracks only jobs in
  its own category, so moving a job it submitted can hide the job from it.
  Read `categories` and the category of that Arr's other jobs first.

While repair, unpack, or post-processing progresses, wait. Do not force/manual
import, remove, blocklist, retry, search, or refresh. After completion, verify
Arr import and Jellyfin availability.
