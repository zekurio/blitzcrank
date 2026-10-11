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

Read with `sonarr_read` inside a `codemode` script. One script can run several
reads and return only what you need. A failed read throws with the server's
message. Results are compacted and lists are capped, and they say when.

```js
const seriesId = 483
const episodes = await tools.sonarr_read({
  resource: "episodes",
  seriesId,
  seasonNumber: 2,
})
const queue = await tools.sonarr_read({ resource: "queue", seriesId })
return { episodes, queue }
```

- Tracking: `series` with `tvdbId` or `seriesId`. One record with seasons and
  statistics.
- Lookup: `lookup` with `term`. Lookup does not prove tracking.
- Episodes: `episodes` with `seriesId`, optional `seasonNumber`. Each episode
  carries its file summary. Match season/episode numbers and check series type.
- Files: `episodeFiles` with `seriesId`.
- Queue: `queue` with `seriesId`. Omit `seriesId` to read the whole queue,
  unknown-series items included, when looking for orphans.
- History: `history` with `seriesId`, optional `eventType`, `page`, `pageSize`
  (max 100).
- Blocklist: `blocklist` with `seriesId`.
- Profiles: `qualityProfiles`.
- Dates: `calendar` with ISO `start` and `end`. Bound the window and match IDs.
  Prefer `airDate`/`airDateUtc`; state timezone uncertainty. Airing does not
  guarantee local availability.
- Manual import: `manualImportCandidates` with `folder` and/or `downloadId`.
- Command status: `command` with `commandId`.
- Anything without a resource: `raw` with a GET `path` under `/api/v3`, for
  example the language profiles on versions that still have them.

Read candidates with `releases`: `episodeId`, or `seriesId` with
`seasonNumber`. Inspect approval, rejections, quality, and custom-format
scores; it grabs nothing. Counts cover every indexer hit, but the listing is one
filtered page: narrow with `publishedAfter`, `titleContains`, `approvedOnly`,
or `limit` before concluding a release is absent.

An empty tracking list does not mean unaired. Candidate rejections describe local
acceptance, not global absence.

For stream/playback reports, load `media-probe`. Probe the paths the services
report: the episode file's path, the queue item's output path, or the completed
SAB job's storage path. Inspect Jellyfin streams. Arr `languages` parse release
names. `MULTi`, `DL`, and `GERMAN` do not prove stream contents or justify
replacement.

## Plan, then apply

Every write is two calls. In a script, call `sonarr_plan` with an `action` and
return the plan. Planning changes nothing. It resolves the target against live
state, so an ID that does not exist fails here. Read the plan's `summary`,
`effects`, and `warnings`. If they match what you intend, call the
`sonarr_apply` tool directly with the `planId`. Scripts cannot call it.

```js
return await tools.sonarr_plan({
  action: "search",
  seriesId: 483,
  episodeIds: [9012],
})
```

Apply re-reads the state the plan depended on. `plan is stale: ...` means that
state moved. Re-read, decide again, and plan again. Apply returns the write's
`result` and a `verification` read-back. `verificationError` means the write
ran and only the read-back failed, so re-read the state yourself before
planning anything else. A second apply of one `planId` returns the first outcome
with `replayed: true` and runs nothing. Plans end at `expiresAt` and do not
survive a server restart, so plan in the run that applies.

## Search and replacement

For missing episodes, inspect monitoring, air dates, files, queue, history, and
paths. Never search unaired/unmonitored episodes or duplicate progressing work.
If nothing is grabbed, report concrete candidate rejections.

Change monitoring only when the issue asks for it or a wrong flag blocks the
requested media. `setSeriesMonitoring` takes `seriesId` and any of `monitored`,
`seasons`, and `monitorNewItems`. It keeps every other series field, and its
plan shows the field-level diff. Setting a season's flag sets all of its
episodes to match, overriding deliberate per-episode choices; check them first.
For single episodes, plan `setEpisodeMonitoring` with `episodeIds` and
`monitored`.

Plan `search` with `seriesId` plus `episodeIds` or `seasonNumber`. `seriesId`
alone searches the whole series and needs a whole-series issue. The plan counts
the monitored episodes in scope and how many already have files that a grab may
replace, and it warns about unaired ones. Narrow the scope until the plan
matches the report. Test hypotheses on one episode, never a season. Probe an
existing file before replacing it on language grounds; missing episodes need
no probe. Let Sonarr choose the release. Plan `grabRelease` with a `guid` and
`indexerId` copied from a fresh `releases` read only when the fix is one
specific release that a search will not pick.

Ask if scope is unclear. Probe corrupt/wrong-content files and inspect Jellyfin
streams. Obtain reporter confirmation before deleting a verified wrong file.
Plan `deleteEpisodeFile` with the `episodeFileId`. The plan names the path, the
size, and every episode the file covers, so check shared-file impact there and
preserve multi-episode relationships. For a wrong season, establish and
announce the full affected set, then replace all of it. Search only affected
episodes.

Identify the bad release's finished `grabbed` history record before repair.
Blocklisting an active grab discards it, and the plan warns when the record is
one. Blocklist only with reliable release identity, before replacement, by
planning `markHistoryFailed` with the `historyId`. Default
`autoRedownloadFailed` also searches; do not add a `search`. Usenet blocklisting
matches one posting, so a re-post of the same title stays grabbable; check
`releases` with `titleContains` for re-posts first. Verify the blocklist and a
different replacement. Plan `deleteBlocklistEntry` with the `blocklistId` only
with a clear identity match.

For missing tracks, search only if a different release is plausible. If streams
exist, investigate Jellyfin/client selection.

For stalls, diagnose category, mapping, permissions, space, locks, naming, and
usable video. Allow download, repair, and unpack work to finish. Fix
infrastructure before retrying. The `command` action runs `RefreshSeries`,
`RescanSeries`, `DownloadedEpisodesScan`, or `RefreshMonitoredDownloads` when
Sonarr must re-read disk or downloader state. Refresh and rescan need the
`seriesId`; the scan needs the folder `path`. For upgrade loops, inspect
history, cutoff, custom-format scores, language, naming, and parsed imported
quality. Correct the rule/parser cause before searching; do not accumulate
blocklist entries.

## Manual import

Read the exact queue folder/download ID and current `manualImportCandidates`.
Inspect every `rejections` array. Import only candidates mapped to that queued
episode and download, with acceptable quality/language evidence. Reject wrong
targets, samples, missing paths, permission or duplicate conflicts, unwanted
language, and low score/cutoff. Never import during downloader post-processing
or while files are locked/changing.

Plan `manualImport` with `importMode: "move"` and `files` carrying `path`,
`folderName`, `seriesId`, `episodeIds`, `quality`, `languages`, and
`releaseGroup`. Every submitted path and ID must come from a Sonarr read. The
plan re-reads the candidates, matches yours by path, and reports rejections as
warnings. Resolve each warning before applying. No generic force import exists.
The apply's verification shows the command just after submission; read
`command` until it finishes, then re-read queue, episode, and file state. Search
is not acquisition; SAB completion is not import. After import, verify Jellyfin
streams and the reported symptom.

If cleanup is warranted instead, plan `removeQueueItem` with `queueId`,
`removeFromClient`, and `blocklist`. `removeFromClient: true` removes the
download and its data. `removeFromClient: false` with `blocklist: true` drops
only the queue entry and blocklists the release.
