---
name: sonarr
description: Use when diagnosing or safely fixing Sonarr series, episode, queue, history, blocklist, manual-import, or TVDB-linked issues from Seerr.
---

# Sonarr Skill

Use `sonarr_request` with relative `/api/v3/...` paths. Every request needs `purpose`. Use GET first. For POST/DELETE/PUT/PATCH, set `safety_level: narrow_mutation` and provide `safety_reason` with the exact target.

## Common reads

- Lookup by TVDB id: `GET /api/v3/series?tvdbId={tvdbId}`
- Search/lookup by title: `GET /api/v3/series/lookup?term={query}`
- List series: `GET /api/v3/series`
- Episodes by series: `GET /api/v3/episode?seriesId={seriesId}`
- Episode file: `GET /api/v3/episodefile/{episodeFileId}`
- Episode files by series: `GET /api/v3/episodefile?seriesId={seriesId}`
- History: `GET /api/v3/history?seriesId={seriesId}&page=1&pageSize=20&sortKey=date&sortDirection=descending`
- Queue: `GET /api/v3/queue?page=1&pageSize=50&includeUnknownSeriesItems=true`
- Blocklist: `GET /api/v3/blocklist?page=1&pageSize=50&seriesId={seriesId}`
- Quality profiles: `GET /api/v3/qualityprofile`
- Language profiles if supported by the instance: `GET /api/v3/languageprofile`
- Manual import candidates: `GET /api/v3/manualimport?folder={urlEncodedFolder}&downloadId={urlEncodedDownloadId}` when a queue item gives a folder/download id.
- Anvil status: use `anvil_status` when a completed download looks blocked only because files are not ready for import yet.
- System status: `GET /api/v3/system/status`

## Narrow mutations

- Search one episode: `POST /api/v3/command` with body `{"name":"EpisodeSearch","episodeIds":[episodeId]}`.
- Search one season: `POST /api/v3/command` with body `{"name":"SeasonSearch","seriesId":seriesId,"seasonNumber":season}`.
- Search series only for whole-series issues: `POST /api/v3/command` with body `{"name":"SeriesSearch","seriesId":seriesId}`.
- Refresh one series: `POST /api/v3/command` with body `{"name":"RefreshSeries","seriesId":seriesId}`.
- Retry known queue item: `POST /api/v3/queue/grab/{queueId}`.
- Remove known queue item and download-client job: `DELETE /api/v3/queue/{queueId}?removeFromClient=true&blocklist=true`. Do not use this for Anvil waits.
- Delete a matching blocklist item: `DELETE /api/v3/blocklist/{blocklistId}`.
- Manual import a verified candidate: `POST /api/v3/command` with body shaped like Sonarr `ManualImport`; use `importMode: "Move"` and `force: true` only when the only blocker is a stale queue/import warning and the candidate is otherwise clearly correct. Do not manual import or force import Anvil waits.

## Diagnostic rules

- For TV issues, identify the Sonarr series before queue/search/blocklist actions; TVDB id from Seerr is the safest link.
- Fetch episodes by series id to find exact episode ids when needed.
- For downloaded file metadata, use episode file data and `mediaInfo` when available.
- For missing audio/subtitle/playback-track reports, verify actual streams with `jellyfin_request` first, then use Sonarr file/history/profile/custom-format evidence to explain how the file was selected or imported.
- Before external/public availability reasoning, exhaust local Sonarr context: history, queue, blocklist, imported file metadata, quality/language/custom-format profiles, and narrow release/search evidence if needed.
- Anvil sits between SABnzbd and Sonarr/Radarr. If Sonarr shows a completed download waiting on file-not-ready evidence and `anvil_status` says Anvil is active or waiting is recommended, treat it as pending encoding/import handoff, not a failed download.
- Prefer the narrowest action that matches the issue. Do not search a whole series when one episode or one season is affected.
- Only delete blocklist entries that clearly match the affected series/episode/release and explain the missing episode.
- Validate every mutation by reading queue/blocklist/episode/file state again.
