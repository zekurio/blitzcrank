---
name: stale-import-handler
description: Find Sonarr/Radarr queue entries where a download is complete but not imported, import only clearly safe manual-import candidates, requeue stalled Anvil encodes that block an import, remove only clearly rejected stale downloads without blocklisting, treat healthy Anvil encoding as a temporary wait, and report actions and manual-review blockers.
schedule: "0 */3 * * *"
enabled: true
capabilities:
  - sonarr.manual_import
  - radarr.manual_import
  - sonarr.queue_rejection_cleanup
  - radarr.queue_rejection_cleanup
  - anvil.job_retry
---

Run the three-hour stale-import sweep. This runbook is self-contained; do not load the general service skills unless an API response raises a question this runbook does not answer.

## Queue gate

1. Read both queues:
   - `sonarr_request`: `/api/v3/queue?page=1&pageSize=100&includeUnknownSeriesItems=true`
   - `radarr_request`: `/api/v3/queue?page=1&pageSize=100&includeUnknownMovieItems=true`
2. Identify completed queue items whose import is blocked, delayed, failed, unknown, or still waiting. If neither queue contains one, immediately finish with `submit_automation_report` using `status: "ok"` and an empty `body`. Do not read automation history or Anvil state on this empty path.

Wait for both queue results before continuing. Do not batch history or Anvil reads with the queue reads.

## Candidate context

Only when the queue gate finds at least one candidate:

1. Search related automation history with `thread_history_search`, using exact candidate titles, release names, download IDs, or paths where available instead of a generic query. History is a clue only; validate it against live state.
2. Read `anvil_status` for control-plane context only. It never proves an item is encoding.
3. Take one `anvil_job_list` snapshot for `pending`, `leased`, `running`, `validating`, `replacing`, and `retrying`; reuse it for all candidates. Absence is meaningful only when `truncated: false`, there is no `output_complete: false`, and there is no blitzcrank truncation marker.

Use an explicit `purpose` on every read. Read SABnzbd only when downloader confirmation is needed, and only through queue/history. Do not load broad skills or fetch unrelated service state pre-emptively.

## Inspect each candidate

Read manual-import candidates when possible:

- Sonarr: `/api/v3/manualimport?folder={folder}&downloadId={downloadId}`
- Radarr: `/api/v3/manualimport?folder={folder}&downloadId={downloadId}`

Inspect every candidate rejection. Correlate Anvil only from an exact absolute Arr `outputPath`, or by matching Arr `downloadId` to SABnzbd `nzo_id` and using that entry's exact absolute storage path. Never construct a path from a title, release, basename, or substring. Call `anvil_job_lookup` only with that exact path.

A unique job is unambiguous. Multiple jobs are one package only when they share library path, source path, and source generation. Cross-source matches or `truncated: true` are ambiguous.

### Classify Anvil state

An item is an **Anvil wait** only when unambiguous exact-path evidence shows an active current job and Arr shows only file-not-ready evidence: no importable file, unavailable/locked/changing path, delayed import, or access-like failure while Anvil owns it.

- Active: `pending`, `leased`, `running`, `validating`, `replacing`, `retrying`.
- `complete`: not a wait; continue normal Arr validation.
- `failed`: consider the retry rules below.
- `skipped` or `canceled`: inspect `last_error` and report for manual review; never retry it.
- Expired lease in `leased`, `running`, `validating`, or `replacing`: re-read shortly. If it persists, or `retrying` persists, report operator recovery under `Manuell prüfen:`; never retry it.
- An exact active job older than 24 hours with current heartbeats but no credible progress requires manual review; never delete or retry work held by a live worker.

A zero exact-path lookup is `UNKNOWN`, not proof of absence. Cross-check the complete active snapshot by exact source, asset, destination, and destination-directory paths. A complete snapshot with no match proves only that the item is not waiting at that moment. An incomplete snapshot disqualifies import, cleanup, and retry.

With no exact path, or with zero lookup plus a complete snapshot, give items younger than 24 hours a generic grace period. Do not mutate or call them Anvil waits. Missing reliable age evidence requires manual review. Old ambiguous/unavailable correlation also requires manual review.

For a healthy Anvil wait, perform no Arr or SABnzbd mutation. Do not list it under manual review. If all candidates are healthy waits and nothing changed, return only the STATUS line.

### Retry one failed Anvil job

Call `anvil_retry_job` only when all are true:

- correlation is exact and unambiguous;
- the id/slug appeared verbatim in an Anvil read this run;
- `anvil_job_show` is complete and reports `failed` with a plausibly transient attempt error such as recovered I/O or a worker dying mid-encode;
- Arr has only the file-not-ready evidence defined above;
- history does not show this automation already retried the same job before it failed again;
- the job was not retried this run.

Never retry active, `retrying`, `skipped`, `complete`, ambiguous, or unavailable jobs; profile/codec/stream-selection failures; repeated identical errors; missing tools/disks/sources; or jobs with incomplete diagnostic output.

For an approved retry, name both job and Arr target in `reason`, inspect built-in verification, then re-read with `anvil_job_show`. A forward state (`pending`, `leased`, `running`, `validating`, `replacing`, `complete`) validates the action. `retrying` or a new terminal failure requires manual review. Report the action under `Neu eingereiht:` and perform no other mutation for that item this run.

## Import or cleanup

### Safe manual import

Import only when the candidate resolves exactly to the queued episode/movie; path and `downloadId` belong to that completed download; quality, language, and custom-format data are acceptable; correlation is complete; the item is not an Anvil wait; and there is no substantive rejection (wrong target, sample, unavailable path, permissions, duplicate, unwanted language, low score, or cutoff).

Pass only fields returned by the manual-import read:

- Sonarr: `path`, `folderName`, `seriesId`, `episodeIds`, `quality`, `languages`, `releaseGroup`, `indexerFlags`; use `sonarr_manual_import` with `importMode: "move"`.
- Radarr: `path`, `folderName`, `movieId`, `quality`, `languages`, `releaseGroup`, `indexerFlags`; use `radarr_manual_import` with `importMode: "auto"`.

Use a target-specific `reason`, inspect built-in verification, then re-read the relevant queue and confirm the stale blocker disappeared. Report under `Importiert:`.

### Rejected-download cleanup

Remove only when the queued target, path, `downloadId`, Arr queue item, and downloader job are unambiguous; explicit rejection/candidate data proves this download is not useful; correlation is complete; and the item is neither an Anvil wait nor retried this run.

Use the current queue's exact `queueId` with `sonarr_delete_queue_item` or `radarr_delete_queue_item`, always `blocklist: false` and `removeFromClient: true`. Inspect verification, re-read the queue, and confirm removal. Report under `Entfernt:`.

Never blocklist: evidence that one download instance is stale is not a verdict on its release. If history shows this automation already removed the same release for the same target and it returned, require manual review instead of deleting it again.

## Hard limits

- Act on every safely covered item, not a sample; report ambiguous items.
- Do not force imports, trigger Arr searches/refreshes, retry SABnzbd, alter blocklists, touch Seerr issues, or work around a rejected mutation.
- Do not re-inspect or mutate unchanged prior manual-review items beyond confirming they remain present.
- A mutation's `reason` must identify the exact verified target. Check every built-in verification and perform the fresh read required above.

## Output

Finish by calling `submit_automation_report` exactly once with the overall `status` and a concise German operations note in `body`. If there are no actions or blockers, use `status: "ok"` and an empty `body`.

Use only non-empty sections: `Importiert:`, `Neu eingereiht:`, `Entfernt:`, `Manuell prüfen:`. Bullets must identify service, title/episode or year, useful release/path context, reason, and validation outcome. After each manual-review bullet, add a separate `MANUAL_INTERVENTION_REQUIRED ...` line with exact known queue/download/release details; the host removes that metadata from Discord.
