---
name: hourly-stale-import-handler
description: Hourly Sonarr/Radarr handler for stale completed downloads that are safe to manually import, force import, or clean up after clear import rejection.
schedule: "@hourly"
---

Run the hourly stale import handler with `sonarr_request`, `radarr_request`, `sabnzbd_request`, and `thread_history_search`.

## Goal

Find Sonarr/Radarr queue entries where a download is complete but not imported. Import only clearly safe manual-import candidates. Remove only clearly rejected stale downloads from Arr and the download client. Report actions from this run and all current manual-review blockers that still remain in the live queues.

## Required first checks

1. Search prior Pi session history with `thread_history_search` for related stale import/manual intervention records when available. Treat results as clues only; current live Sonarr/Radarr evidence is authoritative.
2. Read Sonarr queue: `sonarr_request GET /api/v3/queue?page=1&pageSize=100&includeUnknownSeriesItems=true`.
3. Read Radarr queue: `radarr_request GET /api/v3/queue?page=1&pageSize=100&includeUnknownMovieItems=true`.
4. Consider only completed/stale import candidates where Sonarr/Radarr indicates import is blocked, delayed, failed, unknown, or waiting despite a completed download.

## Candidate inspection

For each relevant queue item:

- Inspect the matching manual import candidates.
  - Sonarr: `GET /api/v3/manualimport?folder={folder}&downloadId={downloadId}` when those fields are available.
  - Radarr: `GET /api/v3/manualimport?folder={folder}&downloadId={downloadId}` when those fields are available.
- Inspect candidate `rejections` before deciding, even when the candidate looks safe.
- Use SABnzbd queue/history only when Sonarr/Radarr evidence needs downloader confirmation, for example `sabnzbd_request GET /api?mode=queue` or `GET /api?mode=history&limit=20`.

## Safe import rules

Import a candidate only when all are true:

- The candidate is resolved by Sonarr/Radarr to the exact queued episode or movie.
- The file path/download id belongs to the queued completed download.
- Quality, language, and custom-format evidence are acceptable for the target.
- There is no substantive rejection such as wrong target, sample, missing path, permissions failure, duplicate/existing file conflict, unwanted language, low score, or profile cutoff.

Mutation shape:

- Sonarr manual import: `sonarr_request POST /api/v3/command` with a Sonarr `ManualImport` command body. Use `importMode: "Move"`.
- Radarr manual import: `radarr_request POST /api/v3/command` with a Radarr `ManualImport` command body. Leave import mode empty or use `auto`.
- For non-GET calls, set `safety_level: "narrow_mutation"` and `safety_reason` naming the exact queue item/candidate.
- Use `force: true` only when the only rejection is a stale queue/import warning and the candidate is otherwise clearly correct.

Validate import by reading the Sonarr/Radarr queue again and confirming the item disappeared or no longer reports the stale import blocker.

## Rejection cleanup rules

Remove a stale download only when all are true:

- Sonarr/Radarr resolves the manual import candidate to the exact queued episode/movie or clearly identifies it as the wrong candidate for that queued target.
- The file path/download id belongs to the queued completed download.
- The explicit rejection/candidate data makes the download clearly not useful to import.
- There is no ambiguity about which queue item and download-client job will be removed.

Mutation shape:

- Sonarr: `DELETE /api/v3/queue/{queueId}?removeFromClient=true&blocklist=true`
- Radarr: `DELETE /api/v3/queue/{queueId}?removeFromClient=true&blocklist=true`

Validate removal by reading the queue again and confirming the item disappeared.

## Do not do these

- Do not mutate any item that current evidence shows is unsafe or ambiguous.
- Do not import uncertain matches.
- Do not force import substantive rejections.
- Do not trigger searches, retries, refreshes, blocklist clearing, filesystem deletion, direct SABnzbd deletion, or Seerr issue resolution from this automation.
- Do not re-inspect or mutate unchanged prior manual-intervention items beyond the evidence needed to confirm they are still present in the live queue.

## Output

Return a German operations note. Suppress empty sections completely.

Use only these sections when they contain concrete items:

- `Importiert:` for validated imports performed in this run.
- `Entfernt:` for validated rejection-based queue removals performed in this run.
- `Manuell prüfen:` for all currently present unsafe/uncertain items requiring human review.

If no imports/removals were performed and no manual-review blockers are currently present, return an empty response.

Each bullet must be human-readable and include the service, title, season/episode or movie year when available, release/folder/file when useful, the practical reason, and the validation outcome for actions.

Examples:

```text
Importiert:
- Sonarr: Example Show S01E02 wurde aus Example.Release importiert; nach der Queue-Prüfung war der Eintrag verschwunden.
```

```text
Entfernt:
- Radarr: Example Movie (2024) wurde entfernt, weil Radarr den Kandidaten eindeutig wegen falscher Sprache ablehnte; nach der Queue-Entfernung mit Download-Client-Cleanup war der Eintrag verschwunden.
```

```text
Manuell prüfen:
- Sonarr: Example Show S01E03 wurde nicht importiert oder entfernt, weil der Queue-Eintrag und der manuelle Kandidat nicht sicher demselben Download zugeordnet werden konnten. MANUAL_INTERVENTION_REQUIRED Sonarr Example Show S01E03 queue=<id> download=<id> release=<name>
```
