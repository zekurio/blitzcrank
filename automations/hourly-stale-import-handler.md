---
name: hourly-stale-import-handler
description: Find Sonarr/Radarr queue entries where a download is complete but not imported, import only clearly safe manual-import candidates, remove only clearly rejected stale downloads, treat Anvil encoding as a temporary wait, and report actions and manual-review blockers.
schedule: "@hourly"
enabled: true
capabilities:
  - sonarr.manual_import
  - radarr.manual_import
  - sonarr.queue_rejection_cleanup
  - radarr.queue_rejection_cleanup
mutation_budget: 5
---

Run the hourly stale import handler.

## Goal

Find Sonarr/Radarr queue entries where a download is complete but not imported, typically because a worse-scored release downloaded before a better-scored one and now sits ignored on disk. Import only clearly safe manual-import candidates. Remove only clearly rejected stale downloads from Arr and the download client. Treat Anvil encoding between SABnzbd and Arr as a normal temporary wait. Report actions from this run and all current manual-review blockers.

## Required first checks

1. Use `thread_history_search` for related stale-import records, preferably with `source: "automations"`. Treat prior transcripts as clues only; live Arr evidence is authoritative.
2. Use `sonarr_request` with an explicit purpose and GET path `/api/v3/queue?page=1&pageSize=100&includeUnknownSeriesItems=true`.
3. Use `radarr_request` with an explicit purpose and GET path `/api/v3/queue?page=1&pageSize=100&includeUnknownMovieItems=true`.
4. Use `anvil_status` with an explicit purpose. This is control-plane context only and never proves that a queue item is encoding.
5. Consider only completed/stale candidates whose import is blocked, delayed, failed, unknown, or still waiting despite a completed download.

## Candidate inspection

- When available, inspect manual-import candidates with a GET read:
  - Sonarr: `sonarr_request` path `/api/v3/manualimport?folder={folder}&downloadId={downloadId}`.
  - Radarr: `radarr_request` path `/api/v3/manualimport?folder={folder}&downloadId={downloadId}`.
- Inspect all candidate rejections before deciding, even when a candidate initially looks safe.
- Read SABnzbd only when downloader confirmation is needed. `sabnzbd_request` may use only `/api?mode=queue` or `/api?mode=history&limit=N`.
- Correlate Anvil per item:
  1. Prefer the exact absolute `outputPath` from the Arr queue entry.
  2. Otherwise, match the Arr `downloadId` to the SABnzbd `nzo_id`, then use that SABnzbd entry's exact absolute storage path.
  3. Call `anvil_job_lookup` only with that exact `absolute_path` and an explicit purpose.
  4. Never construct a path from a title, release name, basename, or substring.
  5. Skip Anvil correlation when no exact path is available.

## Anvil wait rules

An item is an Anvil wait only when **both** conditions hold:

1. Exact-path lookup returns active current jobs: pending, leased, running, validating, replacing, or actively retrying. A single job may be correlated. Multiple jobs may be correlated as one package only when they have the same library path, source path, and source generation. Cross-source multiple matches are ambiguous. A result with `truncated: true` is also ambiguous.
2. Arr/manual-import evidence is only file-not-ready style: no importable files, missing or unavailable path, locked or in-use file, changing size, waiting or delayed import, or access/permission-like failures while Anvil owns the path.

Apply these rules exactly:

- Compare lease and heartbeat timestamps with Anvil `server_time`. An expired lease is potentially stuck: report it under `Manuell prüfen:`, not as healthy waiting.
- Complete jobs are not an Anvil wait; continue normal validation.
- Failed or skipped jobs are concrete blockers and must be reported under `Manuell prüfen:`.
- Zero exact-path matches means the item is not an Anvil wait.
- If no exact path exists, a completed item less than 24 hours past the SABnzbd completion time or Arr queue timestamp may receive a conservative generic grace period. Do not call this an Anvil wait.
- If there is no reliable age evidence, require manual review.
- For Anvil waits, perform no mutations of any kind and no Seerr activity. Do not list healthy Anvil waits under `Manuell prüfen:`.
- If all blockers are healthy Anvil waits and no action was taken, return an empty response.
- An exact active job older than 24 hours without credible progress, or ambiguous/unavailable correlation on an old item, must be reported under `Manuell prüfen:` and must never be auto-deleted.

## Safe import rules

Import only when **all** of these are true:

- The candidate resolves to the exact queued episode or movie.
- Its file path and `downloadId` belong to the queued completed download.
- Quality, language, and custom-format data are acceptable.
- The item is not an Anvil wait.
- There is no substantive rejection, including wrong target, sample, missing path, permissions, duplicate/existing-file conflict, unwanted language, low score, or profile cutoff.

For an approved import:

- Use the candidate object from the manual-import GET response, trimmed to only the applicable fields: `path`, `folderName`, `seriesId`, `episodeIds`, `movieId`, `quality`, `languages`, `releaseGroup`, and `indexerFlags`.
- For Sonarr, call `sonarr_manual_import` with `importMode: "move"`.
- For Radarr, call `radarr_manual_import` with `importMode: "auto"`.
- Set `reason` to a concise explanation naming the exact target being imported.
- Treat the mutation tool's built-in verification as immediate evidence, then independently re-read the relevant Arr queue with the same queue GET used in the first checks. Confirm that the item disappeared or no longer reports the stale blocker.

## Rejection cleanup rules

Remove a stale rejected download only when **all** of these are true:

- The candidate resolves to the exact queued target, or is clearly the wrong candidate for that target.
- Its path and `downloadId` belong to the queued download.
- Explicit rejection or candidate data makes it clearly not useful.
- The item is not an Anvil wait.
- There is no ambiguity about which Arr queue item and download-client job will be removed.

For an approved cleanup:

- Use the exact `queueId` established by the current queue read.
- For Sonarr, call `sonarr_delete_queue_item` with `blocklist: true` and `removeFromClient: true`.
- For Radarr, call `radarr_delete_queue_item` with `blocklist: true` and `removeFromClient: true`.
- Set `reason` to a concise explanation naming the exact queue target being removed.
- Treat the mutation tool's built-in verification as immediate evidence, then independently re-read the relevant Arr queue with the same queue GET used in the first checks. Confirm that the item disappeared.

## Do not do these

- Do not mutate unsafe or ambiguous items.
- Do not import uncertain matches.
- Do not force-import candidates with substantive rejections.
- Do not trigger searches, retries, refreshes, or blocklist clearing.
- Do not re-inspect or mutate unchanged prior manual-intervention items beyond confirming that they are still present.

## Output

Write a concise German operations note.

- Use only these sections, and only when they contain concrete entries:
  - `Importiert:`
  - `Entfernt:`
  - `Manuell prüfen:`
- Suppress empty sections completely.
- Return an empty response when nothing was performed and there are no blockers.
- Bullets must be human-readable and include the service, title, season/episode or year, release/folder/file when useful, practical reason, and validation outcome for actions.
- Every manual-review bullet must end with a searchable `MANUAL_INTERVENTION_REQUIRED` marker line identifying the service and exact known queue/download/release details.

Example:

Importiert:

- Sonarr: Example Show S01E02 wurde aus Example.Release importiert; nach der Queue-Prüfung war der Eintrag verschwunden.

Entfernt:

- Radarr: Example Movie (2024) wurde entfernt, weil Radarr den Kandidaten eindeutig wegen falscher Sprache ablehnte; nach der Queue-Entfernung mit Download-Client-Cleanup war der Eintrag verschwunden.

Manuell prüfen:

- Sonarr: Example Show S01E03 wurde nicht importiert oder entfernt, weil der Queue-Eintrag und der manuelle Kandidat nicht sicher demselben Download zugeordnet werden konnten. MANUAL_INTERVENTION_REQUIRED Sonarr Example Show S01E03 queue=<id> download=<id> release=<name>
