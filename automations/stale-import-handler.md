---
name: stale-import-handler
description: Find Sonarr/Radarr queue entries where a download is complete but not imported, import only clearly safe manual-import candidates, remove only clearly rejected stale downloads without blocklisting, and report actions and manual-review blockers.
schedule: "0 */3 * * *"
enabled: true
mutation_tools:
  - sonarr_manual_import
  - radarr_manual_import
  - sonarr_delete_queue_item
  - radarr_delete_queue_item
---

Run the three-hour stale-import sweep. This runbook is self-contained; do not load the general service skills unless an API response raises a question this runbook does not answer.

## Queue gate

1. Read both queues:
   - `sonarr_request`: `/api/v3/queue?page=1&pageSize=100&includeUnknownSeriesItems=true`
   - `radarr_request`: `/api/v3/queue?page=1&pageSize=100&includeUnknownMovieItems=true`
2. Identify completed queue items whose import is blocked, delayed, failed, unknown, or still waiting. If neither queue contains one, immediately finish with `submit_automation_report` using `status: "ok"` and an empty `body`. Do not read automation history on this empty path.

Wait for both queue results before continuing. Do not batch history or other service reads with the queue reads.

## Candidate context

Only when the queue gate finds at least one candidate:

Search related automation history with `thread_history_search`, using exact candidate titles, release names, download IDs, or paths where available instead of a generic query. History is a clue only; validate it against live state.

Use an explicit `purpose` on every read. Read SABnzbd only when downloader confirmation is needed, and only through queue/history. Do not load broad skills or fetch unrelated service state pre-emptively.

## Inspect each candidate

Read manual-import candidates when possible:

- Sonarr: `/api/v3/manualimport?folder={folder}&downloadId={downloadId}`
- Radarr: `/api/v3/manualimport?folder={folder}&downloadId={downloadId}`

Inspect every candidate rejection. Match Arr `downloadId` to SABnzbd `nzo_id` when downloader confirmation is needed. Never construct a path or identity from a title, release, basename, or substring.

Give items younger than 24 hours a grace period when the download is complete but Arr has not yet produced reliable manual-import evidence. Missing reliable age evidence requires manual review. Old items with incomplete or unavailable correlation also require manual review.

## Import or cleanup

### Safe manual import

Import only when the candidate resolves exactly to the queued episode/movie; path and `downloadId` belong to that completed download; quality, language, and custom-format data are acceptable; correlation is complete; and there is no substantive rejection (wrong target, sample, unavailable path, permissions, duplicate, unwanted language, low score, or cutoff).

Pass only fields returned by the manual-import read:

- Sonarr: `path`, `folderName`, `seriesId`, `episodeIds`, `quality`, `languages`, `releaseGroup`, `indexerFlags`; use `sonarr_manual_import` with `importMode: "move"`.
- Radarr: `path`, `folderName`, `movieId`, `quality`, `languages`, `releaseGroup`, `indexerFlags`; use `radarr_manual_import` with `importMode: "auto"`.

Use a target-specific `reason`, inspect built-in verification, then re-read the relevant queue and confirm the stale blocker disappeared. Report under `Importiert:`.

### Rejected-download cleanup

Remove only when the queued target, path, `downloadId`, Arr queue item, and downloader job are unambiguous; explicit rejection/candidate data proves this download is not useful; and correlation is complete.

Use the current queue's exact `queueId` with `sonarr_delete_queue_item` or `radarr_delete_queue_item`, always `blocklist: false` and `removeFromClient: true`. Inspect verification, re-read the queue, and confirm removal. Report under `Entfernt:`.

Never blocklist: evidence that one download instance is stale is not a verdict on its release. If history shows this automation already removed the same release for the same target and it returned, require manual review instead of deleting it again.

## Hard limits

- Act on every safely covered item, not a sample; report ambiguous items.
- Do not force imports, trigger Arr searches/refreshes, retry SABnzbd, alter blocklists, touch Seerr issues, or work around a rejected mutation.
- Do not re-inspect or mutate unchanged prior manual-review items beyond confirming they remain present.
- A mutation's `reason` must identify the exact verified target. Check every built-in verification and perform the fresh read required above.

## Output

Finish by calling `submit_automation_report` exactly once with the overall `status` and a concise German operations note in `body`. If there are no actions or blockers, use `status: "ok"` and an empty `body`.

Use only non-empty sections: `Importiert:`, `Entfernt:`, `Manuell prüfen:`. Bullets must identify service, title/episode or year, useful release/path context, reason, and validation outcome. After each manual-review bullet, add a separate `MANUAL_INTERVENTION_REQUIRED ...` line with exact known queue/download/release details; the host removes that metadata from Discord.
