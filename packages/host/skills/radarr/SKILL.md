---
name: radarr
description: Check movie availability and release dates. Diagnose and safely repair missing, corrupt, wrong, stalled, or repeatedly replaced movies.
---

# Radarr

## Reads and identity

Resolve title/year and Seerr's `tmdbId` to Radarr's movie ID. Keep TMDB, movie,
movie-file, queue, history, blocklist, and download IDs distinct. Correlate
SAB jobs by download ID.

Load the tools you need with `tool_search`, then call them directly. Put
independent reads in one response. A failed read returns the server's message.
Results are compacted and lists are capped, and they say when.

- Tracking: `radarr_movie` with `tmdbId` or `movieId`. Lookup metadata alone
  proves no import.
- Lookup: `radarr_lookup` with `term`.
- Files: `radarr_movie_files` with `movieId`. Each file carries its quality,
  `customFormats`, `customFormatScore`, and `qualityCutoffNotMet`.
- Queue: `radarr_queue` with `movieId`. Omit `movieId` to read the whole queue,
  unknown-movie items included, when looking for orphans.
- History: `radarr_history` with `movieId`, optional `eventType`, `page`,
  `pageSize` (default 30, max 100). Each record carries the quality,
  languages, `customFormats`, and `customFormatScore` Radarr saw at that
  event. A result carries `next` while more remains: call again with the same
  `movieId` and `eventType` and `next`'s `page`, `pageSize`, and `pageOffset`.
  Pass `pageOffset` only from `next`; a changed `pageSize` moves the page's
  start.
- Blocklist: `radarr_blocklist` with `movieId`.
- Profiles: `radarr_quality_profiles` with the movie's `qualityProfileId` as
  `profileId` for its cutoff, allowed qualities, and nonzero format scores.
  Without `profileId`, it lists IDs and names only. Follow
  `nextFormatScoreOffset` with `formatScoreOffset` if scores are paged.
- Dates: `radarr_calendar` with ISO `start` and `end`. Bound the window and
  match the movie ID. Distinguish `inCinemas`, `digitalRelease`, and
  `physicalRelease`; state uncertainty.
- Manual import: `radarr_manual_import_candidates` with `folder` and/or
  `downloadId`.
- Command status: `radarr_command_status` with `commandId`.
- Health and space: `radarr_health` for Radarr's own health checks, and
  `radarr_disk_space` for free and total bytes per disk as Radarr sees it. An
  empty health list is no reported problem, not proof that all is well.
- Download clients: `radarr_download_clients`. Each client's protocol, enabled
  state, host, `category`, and `directory`, the remote path mappings, and
  whether completed and failed downloads are handled automatically. A `null`
  setting is one the client does not report; it is not a false. The two lists
  share one result: follow `clients.nextClientOffset` with `clientOffset` and
  `remotePathMappings.nextMappingOffset` with `mappingOffset`.

A `null` field is one Radarr did not send, or sent in a shape that could not
be read. It is not evidence that the thing is absent or zero.

Read candidates with `radarr_releases` and `movieId`. Inspect approval,
rejections, quality, and custom-format scores; it grabs nothing. Counts cover
every indexer hit, but the listing is one filtered page: narrow with
`publishedAfter`, `titleContains`, `approvedOnly`, or `limit` before concluding
a release is absent. One search answers every read of the same movie for ten
minutes, whatever the filters, and `searchAgeSeconds` is its age; a write drops
it. Do not read again only to re-check a listing this thread already has.

When it lists no release for the movie, `radarr_releases` also reads Radarr's
health on every call. Its `warnings` then name each indexer problem Radarr
reports, such as indexers failing or in backoff or none able to search, or they
say health could not be read. Either way the empty list proves nothing about
what was published: do not report the release as not out yet. Name the indexer
problem as the blocker. No tool repairs an indexer, and a search command would
ask the same indexers, so the operator has to fix them first.

An empty tracking list does not mean unreleased. Dates and candidate rejections
prove neither watchability nor global source absence.

For stream/playback reports, load `media-probe`. Probe the paths the services
report: the movie file's path, the queue item's output path, the completed SAB
job's storage path, or a history record's dropped or imported path. Inspect
Jellyfin streams. Arr `languages` parse release names, not actual streams.
`MULTi`, `DL`, and `GERMAN` do not justify searches or deletions.

## Writes

A write acts on its first call. Nothing asks you to confirm, so read the exact
target first and check its ID, path, and size against what you intend. The
write resolves its target against live state, so an ID that does not exist
fails with nothing written. The result carries `summary`, `effects`,
`warnings`, and a `verification` read-back.

A rejected write names its reason; read current state before another attempt.
On a `verificationError` the write ran: inspect the live result before any
further write.

## Repair decisions

For missing movies, inspect monitoring, minimum availability, files, queue,
history, and SAB handoff. Respect monitoring and availability. Call
`radarr_auto_search` with the `movieId` once, only when the movie is missing,
after clearing a failed release, or for an explicit replacement/fix request.
Never duplicate progressing work.

Let Radarr choose the release. When this thread already read the movie's
candidates, do not search again: re-read the movie and the queue, then call
`radarr_grab_release` with the `guid` and `indexerId` of the first approved
release in that listing, unfiltered or `approvedOnly`. That is the release a
search would grab, and no indexer is asked again. Take another listed release
only when the fix is one specific release that a search will not pick. Radarr
forgets a search after about 30 minutes and then rejects the grab; call
`radarr_auto_search` then, or when no candidates were read.

Change monitoring only when the report asks for it or a wrong flag blocks the
requested movie. `radarr_set_movie_monitoring` takes `movieId` and `monitored`
and keeps every other movie field.

For stalls, diagnose mapping, permissions, space, locks, category, naming, and
recognized-video failures. Read `radarr_download_clients` for the category
Radarr hands the client and the path mappings, `radarr_disk_space` for space,
and `radarr_health` for what Radarr itself reports. Allow download,
verification, repair, and unpack work to finish before retrying. If Radarr
cannot see an existing file, check runtime path visibility and naming. Call
`radarr_run_command` with `RefreshMovie` and inspect rejections before
duplicating it. It also runs `RescanMovie` and `RefreshMonitoredDownloads`.
Refresh and rescan need the `movieId`; `RefreshMonitoredDownloads` covers
every download and takes none.

`radarr_scan_import_folder` with a folder `path` is an import, not a re-read:
Radarr scans the folder and imports every file it accepts. Its `effects` list
each file with the movie Radarr maps it to. Hold it to the manual-import rules
below, and prefer `radarr_manual_import` when only some files belong.

For upgrade loops, compare what Radarr saw at the grab and at the import in
`radarr_history`, the file's `customFormats` and `customFormatScore` in
`radarr_movie_files`, and the profile's cutoff and scores. A format or quality
that the release title earns and the imported file loses is a common cause.
Also check language, edition, and naming. Correct the rule/parser cause before
searching.

## Replacement

Require reporter details plus item-specific probe, Jellyfin-stream, or Radarr
`mediaInfo` anomaly evidence. Confirm the exact movie/file, multi-version
selection, and originating release. File deletion removes the only disk copy.

1. Identify the bad release's finished `grabbed` history record. Blocklisting
   an active grab would discard it, so read `radarr_queue` for its download ID
   first.
2. Read `radarr_movie_files`, confirm the path and size of the verified
   corrupt/unusable file, and tell the reporter what goes. Then call
   `radarr_delete_movie_file` with its `movieFileId`. Its verification confirms
   the file is gone. An equal-quality release is not an upgrade while that file
   exists.
3. Call `radarr_mark_history_failed` with the `historyId`. Do not search
   before blocklisting. The result says whether Radarr then searches a
   replacement itself, read from Radarr's own redownload settings: a `search`
   effect when it does, a warning when it does not or cannot tell. Add
   `radarr_auto_search` only when no search starts. Usenet blocklisting
   matches one posting, so a re-post of the same title stays grabbable; check
   `radarr_releases` with `titleContains` for re-posts first.
4. Verify the blocklist and a different queued release. Stop if none appears.
   After import, verify edition, audio, and the original playback symptom.

If files disappeared, read `radarr_history` with `pageSize: 100` filtered by
`eventType: "movieFileDeleted"`. The server takes the event name, not
Radarr's number.
Clustered `MissingFromDisk` events indicate infrastructure, not a bad release.
Call `radarr_delete_blocklist_entry` with the `blocklistId` only with a clear
identity match.

## Manual import

Read the exact queue folder/download ID and current
`radarr_manual_import_candidates`. Inspect every `rejections` array. Only an
empty array means Radarr rejects nothing; `rejections: null` means Radarr sent
no list, which is unknown, and an import of that file fails with nothing
written. Import only candidates mapped to that queued movie and download,
with acceptable quality/language evidence. Reject wrong targets, samples,
missing paths, permission or duplicate conflicts, unwanted language, and low
score/cutoff. Never import during downloader post-processing or while files
are locked/changing. Resolve every rejection before importing: the import does
not wait for you to read its warnings.

Call `radarr_manual_import` with `importMode: "auto"` and `files`, each a
candidate `path` and its `movieId`. Pass the `folder` or `downloadId` the
candidates were read with. The server matches each path against the live
candidates and sends their quality, languages, and release group unchanged; a
path Radarr does not offer fails with nothing written. No generic force import
exists. The verification shows the command just after submission; read
`radarr_command_status` until it finishes, then re-read queue and movie-file
state. Command completion is not import; import is not Jellyfin playback.

If cleanup is warranted instead, call `radarr_remove_queue_item` with
`queueId`, `removeFromClient`, and `blocklist`. `removeFromClient: true`
removes the download and its data. `removeFromClient: false` with
`blocklist: true` drops only the queue entry and blocklists the release.
