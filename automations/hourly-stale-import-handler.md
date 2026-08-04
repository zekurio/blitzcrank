---
name: hourly-stale-import-handler
description: Find Sonarr/Radarr queue entries where a download is complete but not imported, import only clearly safe manual-import candidates, requeue stalled Anvil encodes that block an import, remove only clearly rejected stale downloads without blocklisting, treat healthy Anvil encoding as a temporary wait, and report actions and manual-review blockers.
schedule: "@hourly"
enabled: true
model: openrouter/deepseek/deepseek-v4-flash
capabilities:
  - sonarr.manual_import
  - radarr.manual_import
  - sonarr.queue_rejection_cleanup
  - radarr.queue_rejection_cleanup
  - anvil.job_retry
---

Run the hourly stale import handler.

## Goal

Find Sonarr/Radarr queue entries where a download is complete but not imported, typically because a worse-scored release downloaded before a better-scored one and now sits ignored on disk, or because the Anvil encode that owns the file stopped making progress. Import only clearly safe manual-import candidates. Requeue stalled Anvil jobs that block an import. Remove only clearly rejected stale downloads from Arr and the download client, never blocklisting the release. Treat healthy Anvil encoding between SABnzbd and Arr as a normal temporary wait. Report actions from this run and all current manual-review blockers.

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

- Compare lease and heartbeat timestamps with Anvil `server_time`. An expired lease is not healthy waiting: it is a requeue candidate under the Anvil recovery rules below.
- Complete jobs are not an Anvil wait; continue normal validation.
- Failed jobs are a requeue candidate under the Anvil recovery rules below. Skipped jobs are concrete blockers and must be reported under `Manuell prüfen:`.
- Zero exact-path matches means the item is not an Anvil wait.
- If no exact path exists, a completed item less than 24 hours past the SABnzbd completion time or Arr queue timestamp may receive a conservative generic grace period. Do not call this an Anvil wait.
- If there is no reliable age evidence, require manual review.
- For Anvil waits, perform no Arr, SABnzbd, or Seerr mutations, and no Seerr activity. The only action an Anvil-owned item may receive is a requeue under the recovery rules below. Do not list healthy Anvil waits under `Manuell prüfen:`.
- If all blockers are healthy Anvil waits and no action was taken, return an empty response.
- An exact active job older than 24 hours whose lease and heartbeat are still current but which shows no credible progress, or ambiguous/unavailable correlation on an old item, must be reported under `Manuell prüfen:` and must never be auto-deleted or requeued. A live worker is holding that job, and requeuing discards the work it has already done.

## Anvil recovery rules

A stale import is often an encode that stopped: Anvil owns the path, Arr sees a file it cannot import, and nothing changes until the job runs again. Requeue such a job instead of only reporting it — but a requeue restarts the conversion from the start and cannot recover discarded work, so it needs the same certainty a deletion needs.

Requeue with `anvil_retry_job` only when **all** of these are true:

- Correlation was exact-path and unambiguous, by the same rules as an Anvil wait: a single job, or several jobs sharing library path, source path, and source generation. Cross-source matches and any result with `truncated: true` are ambiguous and disqualify the item.
- The job id or slug comes verbatim from this run's `anvil_job_lookup`, `anvil_job_list`, or `anvil_job_show` output. Never construct one.
- You read that job's full history with `anvil_job_show` first, and it reports either:
  - `failed`, with a recorded attempt error a fresh run could plausibly clear — transient I/O, a lost lease, a worker that died mid-encode; or
  - active with a lease expired against `server_time` and no heartbeat progress.
- The blocked Arr evidence is file-not-ready style, exactly as in the wait rules above.
- The job has not already been requeued in this run.

For an approved requeue:

- Call `anvil_retry_job` with that exact job id or slug, and a `reason` naming both the job and the Arr target it blocks.
- Treat the tool's built-in verification as immediate evidence, then independently re-read with `anvil_job_show` and confirm the job is pending or running again.
- The item stays an Anvil wait for the rest of this run: do not import it, remove it, or otherwise mutate its Arr queue entry.
- Report it under `Neu eingereiht:`.

Never requeue when:

- The job is `skipped`. A skip is a recorded decision, not a fault; re-running it just repeats the decision.
- The job is `complete`. A completed encode that still blocks an import is a different problem — continue normal validation.
- The recorded error is a profile, codec, or stream-selection failure, or the same error appears on several attempts. A fresh run reproduces it; report under `Manuell prüfen:`.
- `thread_history_search` shows this automation already requeued the same job on an earlier run and it failed again. One retry is a stalled worker; two is a real fault. Report it under `Manuell prüfen:`.
- Correlation is ambiguous or unavailable, whatever the item's age.

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
- The item is not an Anvil wait, and was not requeued this run.
- There is no ambiguity about which Arr queue item and download-client job will be removed.

For an approved cleanup:

- Use the exact `queueId` established by the current queue read.
- For Sonarr, call `sonarr_delete_queue_item` with `blocklist: false` and `removeFromClient: true`.
- For Radarr, call `radarr_delete_queue_item` with `blocklist: false` and `removeFromClient: true`.
- Set `reason` to a concise explanation naming the exact queue target being removed.
- Treat the mutation tool's built-in verification as immediate evidence, then independently re-read the relevant Arr queue with the same queue GET used in the first checks. Confirm that the item disappeared.

Never blocklist from this automation. `blocklist` is always `false`. What this run establishes is that _this download instance_ is stale — it landed after a better-scored release, or Arr rejected this particular candidate. That is not a finding about the release itself, which may be perfectly good and, for a scarce title, may be the only copy anyone can get. A blocklist entry is permanent, unattended, and invisible at the point where a later search quietly returns nothing.

Because nothing is blocklisted, Arr may grab the same release again. That is the accepted trade, with one guard: if `thread_history_search` shows this automation already removed the same release for the same target on an earlier run and it is stale again, do not remove it a second time. Report it under `Manuell prüfen:` — a repeat grab is a profile, scoring, or indexer problem, and deleting it every hour hides that instead of fixing it.

## Do not do these

- Do not mutate unsafe or ambiguous items.
- Do not import uncertain matches.
- Do not force-import candidates with substantive rejections.
- Do not blocklist anything, and do not remove existing blocklist entries.
- Do not trigger Arr searches, SABnzbd retries, or refreshes. The only retry this automation may perform is an Anvil requeue under the recovery rules.
- Do not requeue an Anvil job to work around a rejection that has nothing to do with encoding.
- Do not re-inspect or mutate unchanged prior manual-intervention items beyond confirming that they are still present.

## Output

Write a concise German operations note.

- Use only these sections, and only when they contain concrete entries:
  - `Importiert:`
  - `Neu eingereiht:`
  - `Entfernt:`
  - `Manuell prüfen:`
- Suppress empty sections completely.
- Return no report body when nothing was performed and there are no blockers.
- Bullets must be human-readable and include the service, title, season/episode or year, release/folder/file when useful, practical reason, and validation outcome for actions.
- After every manual-review bullet, emit a separate line beginning with `MANUAL_INTERVENTION_REQUIRED` and identifying the service and exact known queue/download/release details. This is internal transcript metadata that the host removes from the human-facing report, so the bullet must make sense without it.

Example:

Importiert:

- Sonarr: Example Show S01E02 wurde aus Example.Release importiert; nach der Queue-Prüfung war der Eintrag verschwunden.

Neu eingereiht:

- Anvil: Der Encode für Example Show S01E04 (Job example-job-id) hatte ein abgelaufenes Lease ohne Fortschritt und blockierte den Import; nach dem erneuten Einreihen läuft der Job wieder.

Entfernt:

- Radarr: Example Movie (2024) wurde ohne Blocklist-Eintrag entfernt, weil Radarr den Kandidaten eindeutig wegen falscher Sprache ablehnte; nach der Queue-Entfernung mit Download-Client-Cleanup war der Eintrag verschwunden.

Manuell prüfen:

- Sonarr: Example Show S01E03 wurde nicht importiert oder entfernt, weil der Queue-Eintrag und der manuelle Kandidat nicht sicher demselben Download zugeordnet werden konnten.
  MANUAL_INTERVENTION_REQUIRED Sonarr Example Show S01E03 queue=<id> download=<id> release=<name>
