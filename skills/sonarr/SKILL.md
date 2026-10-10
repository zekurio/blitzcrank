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

Use `sonarr_request` with GET for the reads below. Paths start with `/api/v3`.

- Tracking: `/series?tvdbId={tvdbId}`.
- Lookup: `/series/lookup?term={urlEncodedTitle}`. Lookup does not prove tracking.
- Episodes: `/episode?seriesId={seriesId}&includeEpisodeFile=true`.
  Match season/episode numbers and check series type.
- Files: `/episodefile?seriesId={seriesId}`.
- Queue: `/queue/details?seriesId={seriesId}&includeSeries=true&includeEpisode=true`.
  Broaden to `/queue?page=1&pageSize=50&includeUnknownSeriesItems=true` for orphans.
- History: `/history/series?seriesId={seriesId}`.
- Blocklist: `/blocklist?page=1&pageSize=50&seriesIds={seriesId}`.
- Profiles: `/qualityprofile`; `/languageprofile` when supported.
- Candidates: `/release?episodeId={episodeId}` or
  `/release?seriesId={seriesId}&seasonNumber={seasonNumber}`.
  Inspect approval, rejections, quality, and custom-format scores. Neither grabs.
- Dates: `/calendar?start={urlEncodedISODate}&end={urlEncodedISODate}&unmonitored=true&includeSeries=true&includeEpisodeFile=true`.
  Bound the window and match IDs. Prefer `airDate`/`airDateUtc`; state timezone
  uncertainty. Airing does not guarantee local availability.
- Manual import: `/manualimport?folder={urlEncodedFolder}&downloadId={urlEncodedDownloadId}`.

An empty tracking list does not mean unaired. Candidate rejections describe local
acceptance, not global absence.

For stream/playback reports, load `media-probe`. Probe exact current-run paths
from `episodeFile.path`, queue `outputPath`, or completed SAB `storage`. Inspect
Jellyfin streams. Arr `languages` parse release names. `MULTi`, `DL`, and `GERMAN`
do not prove stream contents or justify replacement.

## Search and replacement

For missing episodes, inspect monitoring, air dates, files, queue, history, and
paths. Never search unaired/unmonitored episodes or duplicate progressing work.
If nothing is grabbed, report concrete candidate rejections.

Change monitoring only when the issue asks for it or a wrong flag blocks the
requested media. `sonarr_set_series_monitoring` sets the series flag, named
seasons, and `monitorNewItems`, and keeps every other series field. Setting a
season's flag sets all of its episodes to match, overriding deliberate
per-episode choices; check them first. For single episodes, send
`PUT /episode/monitor` with `episodeIds` and `monitored`. Raw `PUT /series/{id}`
is refused because an incomplete body resets the series.

Scope `sonarr_search` to exact episodes or a season. Whole-series searches need
a whole-series issue. Set `expectedEpisodeCount` to the actual scoped count for
multi-episode searches and announce it first. Test hypotheses on one episode,
never a season. Replacing two or more existing files requires a current-run
`media_probe` of one of those exact files. Missing episodes are exempt.

Ask if scope is unclear. Probe corrupt/wrong-content files and inspect Jellyfin
streams. Obtain reporter confirmation before deleting a verified wrong file.
Preserve multi-episode relationships and check shared-file impact. For a wrong
season, establish and announce the full affected set, then replace all of it. Search only affected episodes.

Identify the bad release's finished `grabbed` history record before repair.
Blocklisting an active grab discards it. Blocklist only with reliable release
identity, before replacement, via `POST /history/failed/{historyId}`. Default
`autoRedownloadFailed` also searches; do not add `sonarr_search`. Verify the
blocklist and a different replacement. Remove blocklist entries
(`DELETE /blocklist/{id}`) only with a clear identity match.

For missing tracks, search only if a different release is plausible. If streams
exist, investigate Jellyfin/client selection.

For stalls, diagnose category, mapping, permissions, space, locks, naming, and
usable video. Allow download, repair, and unpack work to finish. Fix
infrastructure before retrying. For upgrade loops, inspect history, cutoff,
custom-format scores, language, naming, and parsed imported quality. Correct
the rule/parser cause before searching; do not accumulate blocklist entries.

## Manual import

Read the exact queue folder/download ID and current-run manual-import candidates.
Inspect every `rejections` array. Import only candidates mapped to that queued
episode and download, with acceptable quality/language evidence. Reject wrong
targets, samples, missing paths, permission or duplicate conflicts, unwanted
language, and low score/cutoff. Never import during downloader post-processing
or while files are locked/changing.

Send `POST /command` with `name: "ManualImport"`, `importMode: "move"`, and
`files` trimmed to `path`, `folderName`, `seriesId`, `episodeIds`, `quality`,
`languages`, and `releaseGroup`. Every submitted path and ID must come from a
Sonarr read. No generic force import exists. Verify command status
(`GET /command/{id}`), then re-read queue, episode, and file state. Search is not
acquisition; SAB completion is not import. After import, verify Jellyfin streams
and the reported symptom.

If cleanup is warranted instead, `sonarr_delete_queue_item` removes the download
and its data. To drop only the queue entry, send
`DELETE /queue/{id}?removeFromClient=false&blocklist=true`.

After any write, re-read the affected state; writes return the raw response only.
