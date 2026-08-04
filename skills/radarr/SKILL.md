---
name: radarr
description: Diagnose and safely remediate Radarr-managed movies, releases, queues, imports, files, and quality upgrades. Load for Seerr movie issues involving missing, corrupt, wrong, stalled, or repeatedly replaced media.
---

# Radarr

`radarr_request` is GET-only and accepts `purpose` and a relative `/api/v3/...` `path`. Mutations use the typed tools, require `reason`, and require every target ID to have appeared in a Radarr read on this issue. Issue runs are uncapped; an automation is capped only when its checked-in definition declares a budget.

## Identity and evidence

Keep TMDB, Radarr movie, movie-file, queue, history/blocklist, and download IDs distinct. Seerr's `tmdbId` resolves the internal movie ID; a download ID correlates Radarr with SABnzbd. Commands are asynchronous and do not prove import.

Release/queue/history/file `languages` are release-name parsing (`MULTi`, `DL`, `GERMAN` are claims), not stream evidence. For audio, subtitle, codec, or playback reports, use `media_probe` on `movieFile.path`, queue `outputPath`, or completed SAB `storage`; then inspect imported streams with `jellyfin_request`. Load the `media-probe` skill. Never search or delete based on `languages` alone.

## Reads

- TMDB/title/movie: `GET /api/v3/movie?tmdbId={tmdbId}`, `GET /api/v3/movie/lookup?term={query}`, `GET /api/v3/movie/{movieId}`
- Calendar: `GET /api/v3/calendar?start={urlEncodedISODate}&end={urlEncodedISODate}`
- Files: `GET /api/v3/moviefile/{movieFileId}`, `GET /api/v3/moviefile?movieId={movieId}`
- History: `GET /api/v3/history?movieId={movieId}&page=1&pageSize=20&sortKey=date&sortDirection=descending`
- Queue: `GET /api/v3/queue?page=1&pageSize=50&includeUnknownMovieItems=true`
- Blocklist: `GET /api/v3/blocklist?page=1&pageSize=50&movieId={movieId}`
- Profiles: `GET /api/v3/qualityprofile`
- Manual import: `GET /api/v3/manualimport?folder={urlEncodedFolder}&downloadId={urlEncodedDownloadId}`
- Status: `GET /api/v3/system/status`
- Cross-movie missing-file events: `GET /api/v3/history?page=1&pageSize=100&eventType=6&sortKey=date&sortDirection=descending`

Resolve `tmdbId`, then record movie ID, year, path, monitoring, minimum availability, profile, file state, release title, quality, size, custom formats, edition, and `mediaInfo`. Inspect queue, newest history, blocklist, and profiles. Prefer Radarr calendar/movie dates, naming cinema (`inCinemas`), digital, or physical and stating uncertainty. Correlate download IDs with read-only `sabnzbd_request`; SAB completion is not import.

Anvil is item evidence only when `anvil_job_lookup` matches an exact absolute Radarr `outputPath`, or exact SAB `storage` linked by `downloadId`/`nzo_id`, to an active current job while Radarr reports file-not-ready. `anvil_status`, guessed paths, and title matches are insufficient. Never remove, blocklist, retry, search, refresh, manually import, or delete a movie file during an exact active Anvil wait.

## Typed mutations

Inspect each result's `verification` and follow with narrow reads as needed. Size actions to the verified problem, not a quota; non-destructive mutations are uncapped.

- `radarr_search`: verified `movieId`; do not duplicate a progressing job.
- `radarr_refresh_movie`: verified `movieId`.
- `radarr_grab_queue_item`: verified `queueId`.
- `radarr_delete_queue_item`: verified `queueId` and explicit `blocklist`/`removeFromClient`. `removeFromClient: true` destroys downloaded data and records a deletion; `false` does not.
- `radarr_blocklist_from_history`: verified `historyId` from the release's `grabbed` history record. Radarr starts its own replacement search, so do not add `radarr_search`. Verify the blocklist and that the queue contains a different replacement.
- `radarr_remove_from_blocklist`: only a clearly matching verified `blocklistId`.
- `radarr_delete_movie_file`: verified `movieFileId` from a Radarr read, only for a strongly verified corrupt or unusable exact file. It removes the movie's only copy from disk; verification must report HTTP 404.
- `radarr_manual_import`: use `importMode: "auto"` and candidates from the manual-import GET, trimmed to `path`, `folderName`, `movieId`, `quality`, `languages`, `releaseGroup`, and `indexerFlags` when present. Every submitted path and ID must have appeared in a Radarr read. Verify command status.

No generic force-import tool exists.

## Repair safeguards

For corrupt, unplayable, wrong-cut, or wrong-language media, require item-specific evidence: reporter details plus `media_probe`, Jellyfin streams, or a Radarr `mediaInfo` anomaly. Confirm exact movie/file, multi-version selection, and originating release. Repair in this order:

1. Read history and identify the bad release's `grabbed` record.
2. Delete the file and verify HTTP 404; deletion must precede replacement because an equal-quality release is not an upgrade while the file exists.
3. Blocklist that grab's history ID. This triggers replacement; do not also search.
4. Confirm the queue has a different release. Stop if it does not, schedule a revisit for download/import/playback, and later verify edition, audio, and playback.

Never search before blocklisting: the same highest-scoring release can be re-grabbed and re-imported. If a file merely disappeared, use the cross-movie eventType=6 history read: tightly clustered `MissingFromDisk` events indicate infrastructure, not one release.

For missing movies, inspect monitoring, availability, file, queue, history, SAB, and exact Anvil correlation. Respect monitoring and minimum availability. Search once only when missing, after a failed release is cleared, or when explicitly asked for replacement/fix. For stalls/import failures, allow download/verification/repair/unpack work; diagnose path mapping, permissions, space, locks, category, naming, and recognized-video failures before retrying. For upgrade loops, inspect repeated events, quality, custom-format score, cutoff, language, edition, and naming; correct the rule or parser cause before one verified search. If a file exists but Radarr says missing, confirm path/runtime visibility and naming, refresh, and inspect rejection evidence before creating a duplicate.

For manual import, read the exact queue folder/download ID and candidate endpoint; inspect every `rejections` array. Import only candidates mapped to that queued movie and download with acceptable quality/language evidence. Reject wrong targets, samples, missing paths, permission or duplicate conflicts, unwanted language, and low score/cutoff. Never import while Anvil/transcode owns the path. Re-read queue and movie-file state; use queue deletion with `blocklist: true` when cleanup, not import, is warranted.

## Verification and directives

A grab is not a download; SAB completion is not import; a Radarr file is not Jellyfin playback proof. Verify queue/blocklist/movie/file and the original Jellyfin symptom. Call `report_progress` first with one short public status sentence and no tools, IDs, URLs, or promises. Final output must include `RESOLVE_ISSUE: yes|no`; unresolved work may include `REVISIT_IN` and `REVISIT_REASON`. Resolve only after physical/file-state evidence and the reported symptom are verified.
