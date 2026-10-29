---
name: sonarr
description: Check TV availability and air dates. Diagnose and safely repair missing, corrupt, wrong, stalled, or repeatedly replaced episodes.
---

# Sonarr

## Reads and identity

Resolve the exact series and Seerr's `tvdbId` to Sonarr's series ID. Never
substitute IMDb or anime metadata. Keep TVDB, series, episode, episode-file,
queue, history, blocklist, and download IDs distinct. One file may cover several
episodes. Correlate SAB jobs by download ID.

Load the tools you need with `tool_search`, then call them directly. Put
independent reads in one response. A failed read returns the server's message.
Results are compacted and lists are capped, and they say when.

- Tracking: `sonarr_series` with `tvdbId` or `seriesId`. One record with
  seasons and statistics.
- Lookup: `sonarr_lookup` with `term`. Lookup does not prove tracking.
- Episodes: `sonarr_episodes` with `seriesId`, optional `seasonNumber`. Each
  episode carries its file summary. Match season/episode numbers and check
  series type.
- Files: `sonarr_episode_files` with `seriesId`. Each file carries its
  quality, `customFormats`, `customFormatScore`, and `qualityCutoffNotMet`.
- Queue: `sonarr_queue` with `seriesId`. Omit `seriesId` to read the whole
  queue, unknown-series items included, when looking for orphans.
- History: `sonarr_history` with `seriesId`, optional `eventType`, `page`,
  `pageSize` (default 30, max 100). Each record carries the quality,
  languages, `customFormats`, and `customFormatScore` Sonarr saw at that
  event. A result carries `next` while more remains: call again with the same
  `seriesId` and `eventType` and `next`'s `page`, `pageSize`, and
  `pageOffset`. Pass `pageOffset` only from `next`; a changed `pageSize` moves
  the page's start.
- Blocklist: `sonarr_blocklist` with `seriesId`.
- Profiles: `sonarr_quality_profiles` with the series' `qualityProfileId` as
  `profileId` for its cutoff, allowed qualities, and nonzero format scores.
  Without `profileId`, it lists IDs and names only. Follow
  `nextFormatScoreOffset` with `formatScoreOffset` if scores are paged.
- Dates: `sonarr_calendar` with ISO `start` and `end`. Bound the window and
  match IDs. Prefer `airDate`/`airDateUtc`; state timezone uncertainty. Airing
  does not guarantee local availability.
- Manual import: `sonarr_manual_import_candidates` with `folder` and/or
  `downloadId`.
- Command status: `sonarr_command_status` with `commandId`.
- Health and space: `sonarr_health` for Sonarr's own health checks, and
  `sonarr_disk_space` for free and total bytes per disk as Sonarr sees it. An
  empty health list is no reported problem, not proof that all is well.
- Download clients: `sonarr_download_clients`. Each client's protocol, enabled
  state, host, `category`, and `directory`, the remote path mappings, and
  whether completed and failed downloads are handled automatically. A `null`
  setting is one the client does not report; it is not a false. The two lists
  share one result: follow `clients.nextClientOffset` with `clientOffset` and
  `remotePathMappings.nextMappingOffset` with `mappingOffset`.

A `null` field is one Sonarr did not send, or sent in a shape that could not
be read. It is not evidence that the thing is absent or zero.

Read candidates with `sonarr_releases`: `episodeId`, or `seriesId` with
`seasonNumber`. Inspect approval, rejections, quality, and custom-format
scores; it grabs nothing. Counts cover every indexer hit, but the listing is one
filtered page: narrow with `publishedAfter`, `titleContains`, `approvedOnly`,
or `limit` before concluding a release is absent. One search answers every
read of the same episode or season for ten minutes, whatever the filters, and
`searchAgeSeconds` is its age; a write drops it. Do not read again only to
re-check a listing this thread already has.

When it lists no release for the episode or season, `sonarr_releases` also reads
Sonarr's health on every call. Its `warnings` then name each indexer problem
Sonarr reports, such as indexers failing or in backoff or none able to search,
or they say health could not be read. Either way the empty list proves nothing
about what was published: do not report the release as not out yet. Name the
indexer problem as the blocker. No tool repairs an indexer, and a search command
would ask the same indexers, so the operator has to fix them first.

An empty tracking list does not mean unaired. Candidate rejections describe local
acceptance, not global absence.

For stream/playback reports, load `media-probe`. Probe the paths the services
report: the episode file's path, the queue item's output path, or the completed
SAB job's storage path. Inspect Jellyfin streams. Arr `languages` parse release
names. `MULTi`, `DL`, and `GERMAN` do not prove stream contents or justify
replacement.

## Writes

A write acts on its first call. Nothing asks you to confirm, so read the exact
target first and establish its full extent: which episodes, which files, how
many already have a file. The write resolves its target against live state, so
an ID that does not exist fails with nothing written. The result carries
`summary`, `effects`, `warnings`, and a `verification` read-back.

A rejected write names its reason; read current state before another attempt.
On a `verificationError` the write ran: inspect the live result before any
further write.

## Search and replacement

For missing episodes, inspect monitoring, air dates, files, queue, history, and
paths. Never search unaired/unmonitored episodes or duplicate progressing work.
If nothing is grabbed, report concrete candidate rejections.

Change monitoring only when the report asks for it or a wrong flag blocks the
requested media. `sonarr_set_series_monitoring` takes `seriesId` and any of
`monitored`, `seasons`, and `monitorNewItems`. It keeps every other series
field, and its `effects` show the field-level diff. Setting a season's flag
sets all of its episodes to match, overriding deliberate per-episode choices;
check them first. For single episodes, call `sonarr_set_episode_monitoring`
with `episodeIds` and `monitored`.

Call `sonarr_auto_search` with `seriesId` plus `episodeIds` or `seasonNumber`.
`seriesId` alone searches the whole series and needs a whole-series report. A
series or season search covers every monitored episode in scope, including
ones that already have a file a grab may replace, so read `sonarr_episodes`
and name `episodeIds` until the scope matches the report. Test hypotheses on
one episode, never a season. Probe an existing file before replacing it on
language grounds; missing episodes need no probe.

Let Sonarr choose the release. For one episode whose candidates this thread
already read, do not search again: re-read the episode and the queue, then
call `sonarr_grab_release` with the `guid` and `indexerId` of the first
approved release in that listing, unfiltered or `approvedOnly`. That is the
release a search would grab, and no indexer is asked again. Take another
listed release only when the fix is one specific release that a search will
not pick. Sonarr forgets a search after about 30 minutes and then rejects the
grab; call `sonarr_auto_search` then. Call it too when no candidates were
read, and for a season or several episodes.

Ask if scope is unclear. Probe corrupt/wrong-content files and inspect Jellyfin
streams. Obtain reporter confirmation before deleting a verified wrong file.
Before `sonarr_delete_episode_file`, read `sonarr_episodes` and find every
episode sharing that `episodeFileId`: one file may hold several, and deleting
it removes them all. For a wrong season, establish and announce the full
affected set, then replace all of it. Search only affected episodes.

Identify the bad release's finished `grabbed` history record before repair.
Blocklisting an active grab discards it, so read `sonarr_queue` for its
download ID first. Blocklist only with reliable release identity, before
replacement, by calling `sonarr_mark_history_failed` with the `historyId`.
Its result says whether Sonarr then searches a replacement itself, read from
Sonarr's own redownload settings: a `search` effect when it does, a warning
when it does not or cannot tell. Add `sonarr_auto_search` only when no search
starts. Usenet blocklisting matches one posting, so a re-post of the same
title stays grabbable, and the search Sonarr starts may grab it; check
`sonarr_releases` with `titleContains` for re-posts first. When the fix is one
specific other release, drop and blocklist the running attempt with
`sonarr_remove_queue_item` and `skipRedownload: true` right before
`sonarr_grab_release`, so no search queues a second download. Verify the
blocklist and a different replacement. Call `sonarr_delete_blocklist_entry`
with the `blocklistId` only with a clear identity match.

For missing tracks, search only if a different release is plausible. If streams
exist, investigate Jellyfin/client selection.

For stalls, diagnose category, mapping, permissions, space, locks, naming, and
usable video. Read `sonarr_download_clients` for the category Sonarr hands the
client and the path mappings, `sonarr_disk_space` for space, and
`sonarr_health` for what Sonarr itself reports. Allow download, repair, and
unpack work to finish. Fix infrastructure before retrying.

`sonarr_run_command` runs `RefreshSeries`, `RescanSeries`, or
`RefreshMonitoredDownloads` when Sonarr must re-read disk or downloader state.
Refresh and rescan need the `seriesId`; `RefreshMonitoredDownloads` covers
every download and takes none.

`sonarr_scan_import_folder` with a folder `path` is an import, not a re-read:
Sonarr scans the folder and imports every file it accepts. Its `effects` list
each file with the episodes Sonarr maps it to. Hold it to the manual-import
rules below, and prefer `sonarr_manual_import` when only some files belong.

For upgrade loops, compare what Sonarr saw at the grab and at the import in
`sonarr_history`, the file's `customFormats` and `customFormatScore` in
`sonarr_episode_files`, and the profile's cutoff and scores. A format or
quality that the release title earns and the imported file loses is a common
cause. Also check language and naming. Correct the rule/parser cause before
searching; do not accumulate blocklist entries.

## Manual import

Read the exact queue folder/download ID and current
`sonarr_manual_import_candidates`. Inspect every `rejections` array. Only an
empty array means Sonarr rejects nothing; `rejections: null` means Sonarr sent
no list, which is unknown, and an import of that file fails with nothing
written. Import only candidates mapped to that queued episode and download,
with acceptable quality/language evidence. Reject wrong targets, samples,
missing paths, permission or duplicate conflicts, unwanted language, and low
score/cutoff. Never import during downloader post-processing or while files
are locked/changing. Resolve every rejection before importing: the import does
not wait for you to read its warnings.

Call `sonarr_manual_import` with `importMode: "move"` and `files`, each a
candidate `path` with its `seriesId` and `episodeIds`. Pass the `folder` or
`downloadId` the candidates were read with. The server matches each path
against the live candidates and sends their quality, languages, and release
group unchanged; a path Sonarr does not offer fails with nothing written. No
generic force import exists. The verification shows the command just after
submission; read `sonarr_command_status` until it finishes, then re-read
queue, episode, and file state. Search is not acquisition; SAB completion is
not import. After import, verify Jellyfin streams and the reported symptom.

If cleanup is warranted instead, call `sonarr_remove_queue_item` with
`queueId`, `removeFromClient`, `blocklist`, and `skipRedownload`.
`removeFromClient: true` removes the download and its data.
`removeFromClient: false` with `blocklist: true` drops only the queue entry
and blocklists the release. Blocklisting a download marks it failed, as
`sonarr_mark_history_failed` does, so Sonarr may search a replacement itself.
To drop and blocklist an attempt right before grabbing one specific other
release, pass `skipRedownload: true`. Otherwise read the result's `search`
effect or warning, and add `sonarr_auto_search` only when no search starts.
