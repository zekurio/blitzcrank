---
name: radarr
description: Check movie availability and release dates. Diagnose and safely repair missing, corrupt, wrong, stalled, or repeatedly replaced movies.
---

# Radarr

## Reads and identity

Resolve title/year and Seerr's `tmdbId` to Radarr's movie ID. Keep TMDB, movie,
movie-file, queue, history, blocklist, and download IDs distinct. Correlate
SAB jobs by download ID.

Read with `radarr_read` inside a `codemode` script. One script can run several
reads and return only what you need. A failed read throws with the server's
message. Results are compacted and lists are capped, and they say when.

```js
const movie = await tools.radarr_read({ resource: "movie", tmdbId: 603 })
const queue = await tools.radarr_read({ resource: "queue" })
return { movie, queue }
```

- Tracking: `movie` with `tmdbId` or `movieId`. Lookup metadata alone proves no
  import.
- Lookup: `lookup` with `term`.
- Files: `movieFiles` with `movieId`.
- Queue: `queue` with `movieId`. Omit `movieId` to read the whole queue,
  unknown-movie items included, when looking for orphans.
- History: `history` with `movieId`, optional `eventType`, `page`, `pageSize`.
- Blocklist: `blocklist` with `movieId`.
- Profiles: `qualityProfiles`.
- Dates: `calendar` with ISO `start` and `end`. Bound the window and match the
  movie ID. Distinguish `inCinemas`, `digitalRelease`, and `physicalRelease`;
  state uncertainty.
- Manual import: `manualImportCandidates` with `folder` and/or `downloadId`.
- Command status: `command` with `commandId`.
- Anything without a resource: `raw` with a GET `path` under `/api/v3`.

Read candidates with `releases` and `movieId`. Inspect approval, rejections,
quality, and custom-format scores; it grabs nothing. Counts cover every indexer
hit, but the listing is one filtered page: narrow with `publishedAfter`,
`titleContains`, `approvedOnly`, or `limit` before concluding a release is
absent.

An empty tracking list does not mean unreleased. Dates and candidate rejections
prove neither watchability nor global source absence.

For stream/playback reports, load `media-probe`. Probe the paths the services
report: the movie file's path, the queue item's output path, the completed SAB
job's storage path, or a history record's dropped or imported path. Inspect
Jellyfin streams. Arr `languages` parse release names, not actual streams.
`MULTi`, `DL`, and `GERMAN` do not justify searches or deletions.

## Plan, then apply

A write with an unknown outcome stops the run for operator review. A
completed write whose verification failed is still reported as completed.

Every write is two calls. In a script, call `radarr_plan` with an `action` and
return the plan. Planning changes nothing. It resolves the target against live
state, so an ID that does not exist fails here. Read the plan's `summary`,
`effects`, and `warnings`. If they match what you intend, call the
`radarr_apply` tool directly with the `planId`. Scripts cannot call it.

```js
return await tools.radarr_plan({ action: "deleteMovieFile", movieFileId: 771 })
```

Apply re-reads the state the plan depended on. `plan is stale: ...` means that
state moved. Re-read, decide again, and plan again. Apply returns the write's
`result` and a `verification` read-back. `verificationError` means the write
ran and only the read-back failed, so re-read the state yourself before
planning anything else. A second apply of one `planId` returns the first outcome
with `replayed: true` and runs nothing. Plans end at `expiresAt` and do not
survive a server restart, so plan in the run that applies. Import plans also
check mappings, destination paths, and existing file ids. Queue-removal plans
check other items sharing the download; deleting from a truncated queue is
refused because its full extent is unknown.

## Repair decisions

For missing movies, inspect monitoring, minimum availability, files, queue,
history, and SAB handoff. Respect monitoring and availability. Plan `search`
with the `movieId` once, only when the movie is missing, after clearing a failed
release, or for an explicit replacement/fix request. Never duplicate
progressing work. Let Radarr choose the release. Plan `grabRelease` with a
`guid` and `indexerId` copied from a fresh `releases` read only when the fix is
one specific release that a search will not pick.

Change monitoring only when the issue asks for it or a wrong flag blocks the
requested movie. `setMovieMonitoring` takes `movieId` and `monitored` and keeps
every other movie field.

For stalls, diagnose mapping, permissions, space, locks, category, naming, and
recognized-video failures. Allow download, verification, repair, and unpack work
to finish before retrying. If Radarr cannot see an existing file, check runtime
path visibility and naming. Plan `command` with `RefreshMovie` and inspect
rejections before duplicating it. `command` also runs `RescanMovie`,
`DownloadedMoviesScan`, and `RefreshMonitoredDownloads`. Refresh and rescan
need the `movieId`; the scan needs the folder `path`.

For upgrade loops, inspect history, quality, custom-format score, cutoff,
language, edition, and naming. Correct the rule/parser cause before searching.

## Replacement

Require reporter details plus item-specific probe, Jellyfin-stream, or Radarr
`mediaInfo` anomaly evidence. Confirm the exact movie/file, multi-version
selection, and originating release. File deletion removes the only disk copy.

1. Identify the bad release's finished `grabbed` history record. Blocklisting
   an active grab would discard it.
2. Plan `deleteMovieFile` with the `movieFileId` of the verified
   corrupt/unusable file. Check the path and size the plan names, tell the
   reporter what goes, then apply. The apply verifies the file is gone. An
   equal-quality release is not an upgrade while that file exists.
3. Plan `markHistoryFailed` with the `historyId`. The plan warns when the
   record is an active grab. Default `autoRedownloadFailed` also searches; do
   not add a `search` or search before blocklisting. Usenet blocklisting
   matches one posting, so a re-post of the same title stays grabbable; check
   `releases` with `titleContains` for re-posts first.
4. Verify the blocklist and a different queued release. Stop if none appears.
   After import, verify edition, audio, and the original playback symptom.

If files disappeared, read `history` with `pageSize: 100` filtered by
`eventType: "movieFileDeleted"`. The server takes the event name, not
Radarr's number.
Clustered `MissingFromDisk` events indicate infrastructure, not a bad release.
Plan `deleteBlocklistEntry` with the `blocklistId` only with a clear identity
match.

## Manual import

Read the exact queue folder/download ID and current `manualImportCandidates`.
Inspect every `rejections` array. Import only candidates mapped to that queued
movie and download, with acceptable quality/language evidence. Reject wrong
targets, samples, missing paths, permission or duplicate conflicts, unwanted
language, and low score/cutoff. Never import during downloader post-processing
or while files are locked/changing.

Plan `manualImport` with `importMode: "auto"` and `files` carrying `path`,
`folderName`, `movieId`, `quality`, `languages`, and `releaseGroup`. Every
submitted path and ID must come from a Radarr read. The plan re-reads the
candidates, matches yours by path, and reports rejections as warnings. Resolve
each warning before applying. No generic force import exists. The apply's
verification shows the command just after submission; read `command` until it
finishes, then re-read queue and movie-file state. Command completion is not
import; import is not Jellyfin playback.

If cleanup is warranted instead, plan `removeQueueItem` with `queueId`,
`removeFromClient`, and `blocklist`. `removeFromClient: true` removes the
download and its data. `removeFromClient: false` with `blocklist: true` drops
only the queue entry and blocklists the release.
