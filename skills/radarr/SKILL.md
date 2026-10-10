---
name: radarr
description: Check movie availability and release dates. Diagnose and safely repair missing, corrupt, wrong, stalled, or repeatedly replaced movies.
---

# Radarr

## Reads and identity

Resolve title/year and Seerr's `tmdbId` to Radarr's movie ID. Keep TMDB, movie,
movie-file, queue, history, blocklist, and download IDs distinct. Correlate
SAB jobs by download ID.

Use `radarr_request` with GET for the reads below. Paths start with `/api/v3`.

- Tracking: `/movie?tmdbId={tmdbId}`. Lookup metadata alone proves no import.
- Lookup: `/movie/lookup?term={urlEncodedTitle}`.
- Files: `/moviefile?movieId={movieId}`.
- Queue: `/queue/details?movieId={movieId}&includeMovie=true`.
  Broaden to `/queue?page=1&pageSize=50&includeUnknownMovieItems=true` for orphans.
- History: `/history?movieIds={movieId}&page=1&pageSize=20&sortKey=date&sortDirection=descending`.
- Blocklist: `/blocklist?page=1&pageSize=50&movieIds={movieId}`.
- Profiles: `/qualityprofile`.
- Candidates: `/release?movieId={movieId}`. Inspect approval, rejections, quality,
  and custom-format scores. This read does not grab.
- Dates: `/calendar?start={urlEncodedISODate}&end={urlEncodedISODate}&unmonitored=true`.
  Bound the window and match the movie ID. Distinguish `inCinemas`,
  `digitalRelease`, and `physicalRelease`; state uncertainty.
- Manual import: `/manualimport?folder={urlEncodedFolder}&downloadId={urlEncodedDownloadId}`.

An empty tracking list does not mean unreleased. Dates and candidate rejections
prove neither watchability nor global source absence.

For stream/playback reports, load `media-probe`. Probe exact current-run paths
from `movieFile.path`, queue `outputPath`, completed SAB `storage`, or history
`data.droppedPath`/`data.importedPath`. Inspect Jellyfin streams. Arr `languages`
parse release names, not actual streams. `MULTi`, `DL`, and `GERMAN` do not
justify searches or deletions.

## Repair decisions

For missing movies, inspect monitoring, minimum availability, files, queue,
history, and SAB handoff. Respect monitoring and availability. Search once (`POST /command` with
`name: "MoviesSearch"`, `movieIds: [movieId]`) only when missing, after
clearing a failed release, or for an explicit replacement/fix request. Never
duplicate progressing work.

Change monitoring only when the issue asks for it or a wrong flag blocks the
requested movie. `radarr_set_movie_monitoring` changes only `monitored` and
keeps every other movie field. Raw `PUT /movie/{id}` is refused because an
incomplete body resets the movie.

For stalls, diagnose mapping, permissions, space, locks, category, naming, and
recognized-video failures. Allow download, verification, repair, and unpack work
to finish before retrying. If Radarr cannot see an existing file, check runtime
path visibility and naming. Refresh (`RefreshMovie` command) and inspect
rejections before duplicating it.

For upgrade loops, inspect history, quality, custom-format score, cutoff,
language, edition, and naming. Correct the rule/parser cause before searching.

## Replacement

Require reporter details plus item-specific probe, Jellyfin-stream, or Radarr
`mediaInfo` anomaly evidence. Confirm the exact movie/file, multi-version
selection, and originating release. File deletion removes the only disk copy.

1. Identify the bad release's finished `grabbed` history record. Blocklisting
   an active grab would discard it.
2. Delete the verified corrupt/unusable file with `radarr_delete_movie_file`.
   Verify HTTP 404. An equal-quality release is not an upgrade while that file
   exists.
3. Blocklist the history ID with `POST /history/failed/{historyId}`. Default
   `autoRedownloadFailed` also searches; do not add a search or search before
   blocklisting.
4. Verify the blocklist and a different queued release. Stop if none appears.
   After import, verify edition, audio, and the original playback symptom.

If files disappeared, inspect
`/history?page=1&pageSize=100&eventType=6&sortKey=date&sortDirection=descending`.
Clustered `MissingFromDisk` events indicate infrastructure, not a bad release.
Remove blocklist entries (`DELETE /blocklist/{id}`) only with a clear identity
match.

## Manual import

Read the exact queue folder/download ID and current-run manual-import candidates.
Inspect every `rejections` array. Import only candidates mapped to that queued
movie and download, with acceptable quality/language evidence. Reject wrong
targets, samples, missing paths, permission or duplicate conflicts, unwanted
language, and low score/cutoff. Never import during downloader post-processing
or while files are locked/changing.

Send `POST /command` with `name: "ManualImport"`, `importMode: "auto"`, and
`files` trimmed to `path`, `folderName`, `movieId`, `quality`, `languages`, and
`releaseGroup`. Every submitted path and ID must come from a Radarr read. No
generic force import exists. Verify command status (`GET /command/{id}`), then
re-read queue and movie-file state. Command completion is not import; import is
not Jellyfin playback.

If cleanup is warranted instead, `radarr_delete_queue_item` removes the download
and its data. To drop only the queue entry, send
`DELETE /queue/{id}?removeFromClient=false&blocklist=true`.

After any write, re-read the affected state; writes return the raw response only.
