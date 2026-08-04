---
name: sonarr
description: Diagnose and safely remediate Sonarr-managed TV series, seasons, episodes, queues, imports, files, and quality upgrades. Load for Seerr issues involving a show or episode, especially missing, corrupt, wrong, stalled, or repeatedly replaced media.
---

# Sonarr

`sonarr_request` is GET-only and accepts `purpose` and a relative `/api/v3/...` `path`. Mutations use the typed tools, require `reason`, and require every target ID to have appeared in a Sonarr read on this issue. Issue runs are uncapped; an automation is capped only when its checked-in definition declares a budget.

## Identity and evidence

Keep TVDB, Sonarr series, episode, episode-file, queue, history/blocklist, and download IDs distinct. Seerr's `tvdbId` resolves the internal series ID; a download ID correlates Sonarr with SABnzbd. One episode file may cover several episodes. Monitoring controls search eligibility. Commands are asynchronous: completion proves neither grab nor import.

Release/queue/history/file `languages` are release-name parsing (`MULTi`, `DL`, `GERMAN` are claims), not stream evidence. For audio, subtitle, codec, or playback reports, use `media_probe` on `episodeFile.path`, queue `outputPath`, or completed SAB `storage`; then inspect imported streams with `jellyfin_request`. Load the `media-probe` skill. Never search, replace, or delete based on `languages` alone.

## Reads

- TVDB/title/series: `GET /api/v3/series?tvdbId={tvdbId}`, `GET /api/v3/series/lookup?term={query}`, `GET /api/v3/series`
- Episodes/calendar: `GET /api/v3/episode?seriesId={seriesId}`, `GET /api/v3/calendar?start={urlEncodedISODate}&end={urlEncodedISODate}&includeSeries=true&includeEpisodeFile=true`
- Files: `GET /api/v3/episodefile/{episodeFileId}`, `GET /api/v3/episodefile?seriesId={seriesId}`
- History: `GET /api/v3/history?seriesId={seriesId}&page=1&pageSize=20&sortKey=date&sortDirection=descending`
- Queue: `GET /api/v3/queue?page=1&pageSize=50&includeUnknownSeriesItems=true`
- Blocklist: `GET /api/v3/blocklist?page=1&pageSize=50&seriesId={seriesId}`
- Profiles: `GET /api/v3/qualityprofile`; when supported, `GET /api/v3/languageprofile`
- Manual import: `GET /api/v3/manualimport?folder={urlEncodedFolder}&downloadId={urlEncodedDownloadId}`
- Status: `GET /api/v3/system/status`

Resolve `tvdbId` (never substitute IMDb or anime enrichment or construct unverified links), then record series ID, type, path, monitoring, profile, exact episode IDs, files, queue, newest history, blocklist, and profiles. Exhaust this local evidence and narrow search results before speculating about public availability. Prefer Sonarr `airDate`/`airDateUtc` and state timezone uncertainty. Correlate download IDs through read-only `sabnzbd_request`; SAB completion is not import.

Anvil is item evidence only when `anvil_job_lookup` matches an exact absolute queue `outputPath`, or exact SAB `storage` linked by `downloadId`/`nzo_id`; `anvil_status`, guessed paths, and title matches are insufficient. Never remove, blocklist, retry, search, refresh, manual-import, or force-import an exact active Anvil wait.

## Typed mutations

Inspect each result's `verification` and follow with narrow reads as needed.

- `sonarr_search`: supply verified `seriesId` plus exact `episodeIds`, or `seasonNumber`; omit both only for a whole-series issue. For more than one episode, `expectedEpisodeCount` must equal Sonarr's actual count and that scope must first be stated to the reporter. Replacing two or more existing files also requires `media_probe` on one of those exact files during this run; missing episodes are exempt. Test a hypothesis on one episode. Never launch a season search as a probe.
- `sonarr_refresh_series`: verified `seriesId`.
- `sonarr_grab_queue_item`: verified `queueId`.
- `sonarr_delete_queue_item`: verified `queueId` and explicit `blocklist`/`removeFromClient`. `removeFromClient: true` destroys downloaded data and records a deletion; `false` does not.
- `sonarr_blocklist_from_history`: verified `historyId` from the release's `grabbed` history record. Use this before replacement: the formerly highest-scoring release may win again. Sonarr starts a search, so do not add `sonarr_search`. Verify the new blocklist and queue entry.
- `sonarr_remove_from_blocklist`: only a clearly matching verified `blocklistId`.
- `sonarr_delete_episode_file`: only a verified wrong `episodeFileId`, after reporter confirmation of replacement. Preserve multi-episode relationships, then search only affected episodes. For a verified wrong season, establish and tell the reporter the full extent, then delete every affected file; the count is uncapped, and a partly deleted season is worse than finishing or not starting.
- `sonarr_manual_import`: use `importMode: "move"` and candidates from the manual-import GET, trimmed to `path`, `folderName`, `seriesId`, `episodeIds`, `quality`, `languages`, `releaseGroup`, and `indexerFlags` when present. Every submitted path and ID must have appeared in a Sonarr read. Verify command status.

No generic force-import tool exists.

## Decisions and verification

If issue scope is absent, ask for clarification rather than making broad changes. For missing episodes, check monitoring, air date, file, queue, history, and path; do not search unaired/unmonitored episodes or duplicate progressing work. If no grab results, report concrete profile, language, custom-format, age, size, or indexer rejection evidence.

For corruption/wrong content, probe the file, inspect Jellyfin streams and shared-file impact, identify the originating history release, then make one targeted repair. Blocklist only with reliable release identity. For a missing track, search only when a genuinely different release is plausible; the same release cannot add a track absent from its file. If the track exists but playback omits it, investigate Jellyfin/client selection.

For stalls/import failures, allow download/repair/unpack work and diagnose category, mapping, permissions, space, locks, naming, usable video, and exact Anvil ownership before retrying. Fix infrastructure before re-searching. For repeated upgrades, inspect history, cutoff, custom-format scores, language, naming, and parsed imported quality; correct the rule or parser cause before one verified search rather than accumulating blocklist entries.

For manual import, read the exact queue folder/download ID and candidate endpoint; inspect every `rejections` array. Import only candidates mapped to that queued episode and download with acceptable quality/language evidence. Reject wrong targets, samples, missing paths, permission or duplicate conflicts, unwanted language, and low score/cutoff. Never import while Anvil/transcode owns the path. Re-read queue and file state; use queue deletion with `blocklist: true` when cleanup, not import, is warranted.

A search is not a grab; a grab is not a download; import is not Jellyfin playback. Verify queue/blocklist/episode/file state, ensure any replacement differs, and after import verify the file record and Jellyfin streams. Call `report_progress` first with one short public status sentence and no tools, IDs, URLs, or promises. Final output must include `RESOLVE_ISSUE: yes|no`; unresolved work may include `REVISIT_IN` and `REVISIT_REASON`. Resolve only when the reported symptom is objectively verified or required reporter confirmation is obtained.
