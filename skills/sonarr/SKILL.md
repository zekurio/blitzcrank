---
name: sonarr
description: Answer series, season, and episode availability or air-date questions using Sonarr tracking, imports, candidates, and calendar. Also diagnose and safely remediate missing, corrupt, wrong, stalled, or repeatedly replaced TV media.
---

# Sonarr

`sonarr_request` is GET-only and accepts `purpose` and a relative `/api/v3/...` `path`. Mutations use the typed tools, require `reason`, and require every target ID to pass the run's Sonarr evidence gate. Issue, Discord, and automation runs are uncapped; automation scope comes from its exact mutation-tool allowlist.

## Availability and dates

For factual questions, use reads only. Resolve the exact series and TVDB ID,
then `GET /api/v3/series?tvdbId={tvdbId}` and
`GET /api/v3/series/{seriesId}` for tracking and monitoring. If title identity
is missing, use `GET /api/v3/series/lookup?term={urlEncodedTitle}`; lookup
metadata does not establish that the series is tracked or imported.

- Episodes/imports: `GET /api/v3/episode?seriesId={seriesId}&includeEpisodeFile=true`.
  Match the requested season/episode; use
  `GET /api/v3/episodefile?seriesId={seriesId}` when file details are needed.
- Acquiring: `GET /api/v3/queue/details?seriesId={seriesId}&includeSeries=true&includeEpisode=true`.
- Candidates, when relevant to why an episode is not acquired:
  `sonarr_releases` with `episodeId`, or with `seriesId` and
  `seasonNumber` for a season. Read `approved` and `rejections` alongside
  quality and custom-format scores. Counts cover every indexer hit; the listing
  is one filtered page, so narrow with `publishedAfter`, `titleContains`, or
  `approvedOnly` before concluding a release is absent. It lists candidates;
  it does not grab them. Rejected candidates explain local acceptance
  decisions, not global source absence.
- Dates: `GET /api/v3/calendar?start={urlEncodedISODate}&end={urlEncodedISODate}&unmonitored=true&includeSeries=true&includeEpisodeFile=true`.
  Match series and episode IDs within a bounded date window. `airDate` and
  `airDateUtc` describe airing, not a guaranteed homelab availability date.
  State timezone uncertainty when relevant.

Sonarr describes tracking, acquisition, and imports; Jellyfin describes actual
serving/playback. Check Jellyfin for "can I watch it?" and use web only for missing
external context. A service auth/error or no matching result leaves that source's
answer unknown, not a global "unavailable". A successful empty series list means
not tracked in Sonarr, not unaired. Continue useful independent services;
Jellyfin HTTP 401 does not block Sonarr reads. Do not repeat the same failed call.

## Identity and evidence

Keep TVDB, Sonarr series, episode, episode-file, queue, history/blocklist, and download IDs distinct. Seerr's `tvdbId` resolves the internal series ID; a download ID correlates Sonarr with SABnzbd. One episode file may cover several episodes. Monitoring controls search eligibility. Commands are asynchronous: completion proves neither grab nor import.

Release/queue/history/file `languages` are release-name parsing (`MULTi`, `DL`, `GERMAN` are claims), not stream evidence. For audio, subtitle, codec, or playback reports, use `media_probe` on `episodeFile.path`, queue `outputPath`, or completed SAB `storage`; then inspect imported streams with `jellyfin_request`. Load the `media-probe` skill. Never search, replace, or delete based on `languages` alone.

## Reads

- TVDB/title/series: `GET /api/v3/series?tvdbId={tvdbId}`, `GET /api/v3/series/lookup?term={query}`, `GET /api/v3/series`
- Episodes/calendar: `GET /api/v3/episode?seriesId={seriesId}`, `GET /api/v3/calendar?start={urlEncodedISODate}&end={urlEncodedISODate}&includeSeries=true&includeEpisodeFile=true`
- Files: `GET /api/v3/episodefile/{episodeFileId}`, `GET /api/v3/episodefile?seriesId={seriesId}`
- History: `GET /api/v3/history/series?seriesId={seriesId}`
- Queue: `GET /api/v3/queue?page=1&pageSize=50&includeUnknownSeriesItems=true`
- Blocklist: `GET /api/v3/blocklist?page=1&pageSize=50&seriesIds={seriesId}`
- Profiles: `GET /api/v3/qualityprofile`; when supported, `GET /api/v3/languageprofile`
- Manual import: `GET /api/v3/manualimport?folder={urlEncodedFolder}&downloadId={urlEncodedDownloadId}`
- Status: `GET /api/v3/system/status`

For troubleshooting, resolve `tvdbId` (never substitute IMDb or anime enrichment or construct unverified links), then record series ID, type, path, monitoring, profile, exact episode IDs, files, queue, newest history, blocklist, and profiles. Use relevant local evidence and narrow candidate results before speculating about public availability. Prefer Sonarr `airDate`/`airDateUtc` and state timezone uncertainty. Correlate download IDs through read-only `sabnzbd_request`; SAB completion is not import.

## Typed mutations

Inspect each result's `verification` and follow with narrow reads as needed.

- `sonarr_search`: supply verified `seriesId` plus exact `episodeIds`, or `seasonNumber`; omit both only for a whole-series issue. For more than one episode, `expectedEpisodeCount` must equal Sonarr's actual count and that scope must first be stated to the reporter. Replacing two or more existing files also requires `media_probe` on one of those exact files during this run; missing episodes are exempt. Test a hypothesis on one episode. Never launch a season search as a probe.
- `sonarr_refresh_series`: verified `seriesId`.
- `sonarr_grab_queue_item`: verified `queueId`.
- `sonarr_delete_queue_item`: verified `queueId` and explicit `blocklist`/`removeFromClient`. `removeFromClient: true` destroys downloaded data and records a deletion; `false` does not.
- `sonarr_blocklist_from_history`: verified `historyId` from the release's `grabbed` history record. Use this before replacement: the formerly highest-scoring release may win again. Usenet blocklisting matches one posting, so a re-post of the same title stays grabbable; check `sonarr_releases` with `titleContains` for re-posts first. Sonarr starts a search, so do not add `sonarr_search`. Verify the new blocklist and queue entry.
- `sonarr_remove_from_blocklist`: only a clearly matching verified `blocklistId`.
- `sonarr_delete_episode_file`: only a verified wrong `episodeFileId`, after reporter confirmation of replacement. Preserve multi-episode relationships, then search only affected episodes. For a verified wrong season, establish and tell the reporter the full extent, then delete every affected file; the count is uncapped, and a partly deleted season is worse than finishing or not starting.
- `sonarr_manual_import`: use `importMode: "move"` and candidates from the manual-import GET, trimmed to `path`, `folderName`, `seriesId`, `episodeIds`, `quality`, `languages`, `releaseGroup`, and `indexerFlags` when present. Every submitted path and ID must have appeared in a Sonarr read. Verify command status.

No generic force-import tool exists.

## Decisions and verification

If issue scope is absent, ask for clarification rather than making broad changes. For missing episodes, check monitoring, air date, file, queue, history, and path; do not search unaired/unmonitored episodes or duplicate progressing work. If no grab results, report concrete profile, language, custom-format, age, size, or indexer rejection evidence.

For corruption/wrong content, probe the file, inspect Jellyfin streams and shared-file impact, identify the originating history release, then make one targeted repair. Blocklist only with reliable release identity. For a missing track, search only when a genuinely different release is plausible; the same release cannot add a track absent from its file. If the track exists but playback omits it, investigate Jellyfin/client selection.

For stalls/import failures, allow download/repair/unpack work and diagnose category, mapping, permissions, space, locks, naming, and usable video before retrying. Fix infrastructure before re-searching. For repeated upgrades, inspect history, cutoff, custom-format scores, language, naming, and parsed imported quality; correct the rule or parser cause before one verified search rather than accumulating blocklist entries.

For manual import, read the exact queue folder/download ID and candidate endpoint; inspect every `rejections` array. Import only candidates mapped to that queued episode and download with acceptable quality/language evidence. Reject wrong targets, samples, missing paths, permission or duplicate conflicts, unwanted language, and low score/cutoff. Never import while downloader post-processing is active or the file is locked/changing. Re-read queue and file state; use queue deletion with `blocklist: true` when cleanup, not import, is warranted.

A search is not a grab; a grab is not a download; import is not Jellyfin playback. Verify queue/blocklist/episode/file state, ensure any replacement differs, and after import verify the file record and Jellyfin streams. In a Seerr issue, call `report_progress` first and finish with the required `RESOLVE_ISSUE` directive block. In Discord, answer directly without Seerr directives or promises of a later check. Resolve a Seerr issue only when the reported symptom is objectively verified or required reporter confirmation is obtained.
