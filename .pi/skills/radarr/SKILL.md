---
name: radarr
description: Use when diagnosing or safely fixing Radarr movie, queue, history, blocklist, manual-import, or TMDB-linked issues from Seerr.
---

# Radarr Skill

Use `radarr_request` with relative `/api/v3/...` paths. Every request needs `purpose`. Use GET first. For POST/DELETE/PUT/PATCH, set `safety_level: narrow_mutation` and provide `safety_reason` with the exact target.

## Common reads

- Lookup by TMDB id: `GET /api/v3/movie?tmdbId={tmdbId}`
- Lookup by title/TMDB term: `GET /api/v3/movie/lookup?term={query}`
- Movie by Radarr id: `GET /api/v3/movie/{movieId}`
- Calendar window: `GET /api/v3/calendar?start={urlEncodedISODate}&end={urlEncodedISODate}` for upcoming or recent movie releases. Use `inCinemas`, `digitalRelease`, `physicalRelease`, and availability metadata to explain which kind of date Radarr knows.
- Movie file: `GET /api/v3/moviefile/{movieFileId}`
- History: `GET /api/v3/history?movieId={movieId}&page=1&pageSize=20&sortKey=date&sortDirection=descending`
- Queue: `GET /api/v3/queue?page=1&pageSize=50&includeUnknownMovieItems=true`
- Blocklist: `GET /api/v3/blocklist?page=1&pageSize=50&movieId={movieId}`
- Quality profiles: `GET /api/v3/qualityprofile`
- Manual import candidates: `GET /api/v3/manualimport?folder={urlEncodedFolder}&downloadId={urlEncodedDownloadId}` when a queue item gives a folder/download id.
- Anvil status: use `anvil_status` when a completed download looks blocked only because files are not ready for import yet.
- System status: `GET /api/v3/system/status`

## Narrow mutations

- Search one movie: `POST /api/v3/command` with body `{"name":"MoviesSearch","movieIds":[movieId]}`.
- Refresh one movie: `POST /api/v3/command` with body `{"name":"RefreshMovie","movieIds":[movieId]}`.
- Retry known queue item: `POST /api/v3/queue/grab/{queueId}`.
- Remove known queue item and download-client job: `DELETE /api/v3/queue/{queueId}?removeFromClient=true&blocklist=true`. Do not use this for Anvil waits.
- Delete a matching blocklist item: `DELETE /api/v3/blocklist/{blocklistId}`.
- Manual import a verified candidate: `POST /api/v3/command` with body shaped like Radarr `ManualImport`; leave import mode empty or use `auto`. Use `force: true` only when the only blocker is a stale queue/import warning and the candidate is otherwise clearly correct. Do not manual import or force import Anvil waits.

## Diagnostic rules

- For movie issues, identify the Radarr movie before queue/search/blocklist actions; TMDB id from Seerr is the safest link.
- Treat Radarr's TMDB id as the primary external identity for the monitored movie. Use IMDb or other database ids only as enrichment or cross-checks; they must not override a TMDB-backed Radarr match. Verify links through web search rather than constructing unconfirmed URLs.
- For release-date questions, prefer the matching movie and Radarr calendar data over generic web schedules. Name the release type (cinema, digital, or physical) and state date uncertainty when it matters.
- Fetch movie file metadata and `mediaInfo` when explaining imported quality, language, audio, subtitles, or custom formats.
- For missing audio/subtitle/playback-track reports, verify actual streams with `jellyfin_request` first, then use Radarr file/history/profile/custom-format evidence to explain how the file was selected or imported.
- Before external/public availability reasoning, exhaust local Radarr context: history, queue, blocklist, imported file metadata, quality/language/custom-format profiles, and narrow release/search evidence if needed.
- Anvil sits between SABnzbd and Sonarr/Radarr. Treat a completed Radarr download as pending Anvil work only when `anvil_job_lookup` exactly matches its absolute `outputPath`, or an exact SABnzbd `storage` path linked by `downloadId`/`nzo_id`, to active current jobs and the Radarr evidence is file-not-ready. Daemon health alone is never item evidence.
- Search the movie only when it is missing, a failed release was cleared, or the user explicitly asks for replacement/fix.
- Do not repeatedly trigger searches without checking queue/history/blocklist state between attempts.
- Only delete blocklist entries that clearly match the affected movie/release and explain the missing movie.
- Validate every mutation by reading queue/blocklist/movie/file state again.
