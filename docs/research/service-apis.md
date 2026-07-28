# Media service HTTP API cheat sheet

Verified 2026-07-28 against the Sonarr/Radarr `develop` OpenAPI specs, SABnzbd 5.0 API wiki, and Jellyfin stable OpenAPI. JSON is assumed. Use read-only calls first; file/job deletion is destructive.

## Sonarr

**Base:** `/api/v3`  
**Auth:** `X-Api-Key: <key>` (the spec also permits `?apikey=`, but the header is preferable).

| Method | Path | Key query/body parameters | Diagnostic use |
|---|---|---|---|
| GET | `/series?tvdbId={tvdbId}` | `tvdbId` | Resolve an already-added series from a TVDB ID; returns an array, normally zero or one record. |
| GET | `/series/lookup?term=tvdb:{tvdbId}` | `term` also accepts a title/search term | Look up metadata for a series not yet in Sonarr. |
| GET | `/series/{id}` | Sonarr series `id` | Inspect monitored state, path, quality profile, seasons, and statistics. |
| GET | `/episode?seriesId={id}&includeEpisodeFile=true` | `seriesId`; optional `seasonNumber`, `episodeIds`, `episodeFileId`, `includeSeries`, `includeEpisodeFile` | List episodes and determine missing/monitored state; embedded `episodeFile` avoids a second lookup. |
| GET | `/episodefile?seriesId={id}` | `seriesId`; alternatively `episodeFileIds` | List physical episode-file records for a series, including path, size, quality, languages, and media info. |
| GET | `/episodefile/{id}` | Episode-file `id` | Inspect one imported file in detail. |
| GET | `/queue` | Pagination; `includeSeries=true`, `includeEpisode=true`; filters `seriesIds`, `status`, `protocol`, `languages`, `quality` | Diagnose downloads globally; inspect `status`, `trackedDownloadStatus/state`, `statusMessages`, `errorMessage`, progress, and download-client ID. |
| GET | `/queue/details?seriesId={id}&includeSeries=true&includeEpisode=true` | `seriesId`; optional `episodeIds` | Get unpaged queue details narrowed to a series/episodes. |
| GET | `/queue/status` | None | Check aggregate queue/client warning state. |
| GET | `/history?episodeId={episodeId}` | Pagination; `episodeId`; optional `eventType`, `downloadId`, `includeSeries`, `includeEpisode` | Trace grabs, downloads, imports, failures, and deletions for one episode. |
| GET | `/history/series?seriesId={id}` | `seriesId`; optional `seasonNumber`, `eventType`, includes | Trace a whole series or season when an episode-specific history query is insufficient. |
| POST | `/command` | `{"name":"EpisodeSearch","episodeIds":[123]}` | Search indexers for one or more specific missing/bad episodes. |
| POST | `/command` | `{"name":"SeriesSearch","seriesId":45}` | Search all eligible monitored episodes in a series. |
| POST | `/command` | `{"name":"MissingEpisodeSearch","seriesId":45,"monitored":true}`; may instead use `seriesIds` and `qualityProfileIds` | Launch a broader missing-episode search. |
| POST | `/command` | `{"name":"RescanSeries","seriesId":45}` | Re-scan disk after an external file repair/move or suspected stale media info. |
| GET | `/command/{id}` | Command ID returned by `POST /command` | Poll `status`, `message`, and completion after launching a search/rescan. |
| DELETE | `/episodefile/{id}` | Episode-file `id` | Remove Sonarr's file record **and the media file** before replacement; destructive. |
| GET | `/blocklist` | Pagination; optional `seriesIds`, `protocols` | Check whether prior bad/failed releases are blocked from re-grab. |
| DELETE | `/blocklist/{id}` | Blocklist record `id` | Permit reconsideration of a release; use only after diagnosing why it was blocked. |
| GET | `/health` | None | Retrieve Sonarr health warnings/errors such as indexer, download-client, root-folder, or update issues. |

## Radarr

**Base:** `/api/v3`  
**Auth:** `X-Api-Key: <key>` (query `apikey` is also in the spec).

| Method | Path | Key query/body parameters | Diagnostic use |
|---|---|---|---|
| GET | `/movie?tmdbId={tmdbId}` | `tmdbId`; optional `excludeLocalCovers` | Resolve an already-added movie from a TMDB ID; returns an array. |
| GET | `/movie/lookup/tmdb?tmdbId={tmdbId}` | `tmdbId` | Look up metadata for a movie not yet in Radarr. |
| GET | `/movie/{id}` | Radarr movie `id` | Inspect monitored state, path, minimum availability, quality profile, and file presence. |
| GET | `/moviefile?movieId={id}` | `movieId` is represented as an array-capable query parameter; alternatively `movieFileIds` | List file records and inspect path, size, quality, languages, edition, and media info. |
| GET | `/moviefile/{id}` | Movie-file `id` | Inspect one imported movie file. |
| GET | `/queue` | Pagination; `includeMovie=true`; filters `movieIds`, `status`, `protocol`, `languages`, `quality` | Diagnose stuck/failed downloads via status, tracked state, messages, progress, and client ID. |
| GET | `/queue/details?movieId={id}&includeMovie=true` | `movieId` | Get unpaged queue details for one movie. |
| GET | `/queue/status` | None | Check aggregate queue/download-client warning state. |
| GET | `/history?movieIds={id}` | Pagination; `movieIds`; optional `eventType`, `downloadId`, `includeMovie` | Trace grabs, downloads, imports, failures, and deletions for a movie. |
| GET | `/history/movie?movieId={id}` | `movieId`; optional `eventType`, `includeMovie` | Get the movie-focused history feed. |
| POST | `/command` | `{"name":"MoviesSearch","movieIds":[123]}` | Search indexers for one or more missing/bad movies. |
| POST | `/command` | `{"name":"RescanMovie","movieId":123}` | Re-scan disk after repair/move or suspected stale file/media data. |
| GET | `/command/{id}` | Returned command ID | Poll command state and completion. |
| DELETE | `/moviefile/{id}` | Movie-file `id` | Remove Radarr's record **and the media file** before replacement; destructive. |
| GET | `/blocklist` | Pagination; optional `movieIds`, `protocols` | Find releases blocked after failed/bad downloads. |
| DELETE | `/blocklist/{id}` | Blocklist record `id` | Remove a blocklist entry after investigating the failure. |
| GET | `/health` | None | Retrieve Radarr health warnings/errors. |

## SABnzbd

**Base:** `/api`  
**Auth/output:** every request should include `apikey=<key>&output=json`. API operations use query parameters and are conventionally sent as `GET` (do not put keys in logs).

| Method | Path/query | Key parameters | Diagnostic use |
|---|---|---|---|
| GET | `/api?mode=queue` | `start`, `limit`, `search`, `cat`, `priority`, `status`, `nzo_ids` | Inspect active jobs, state, labels, speed, remaining size/time, filename, category, and `nzo_id`. |
| GET | `/api?mode=history` | `start`, `limit`, `search`, `cat`, `status`, `nzo_ids`, `failed_only=1`, `archive`, `last_history_update` | Inspect completed/post-processing jobs; use `failed_only=1` (shorthand for `status=Failed`) and read `fail_message`, path/storage, script/log fields. |
| GET | `/api?mode=retry&value={nzo_id}` | Failed job `nzo_id` | Retry one failed history job. The wiki lists `retry` and the standard `value` form, but does not show a dedicated example beside the current text; **parameter form should be integration-tested against the installed SABnzbd version**. |
| GET | `/api?mode=retry_all` | None | Retry all failed jobs; risky for an automated bot, so require confirmation. |
| GET | `/api?mode=queue&name=delete&value={nzo_id}` | `value`; optional `del_files=1`; comma-separated IDs or `all` supported | Delete an active job; `del_files=1` also removes downloaded files. |
| GET | `/api?mode=history&name=delete&value={nzo_id}` | `value`; optional `archive=0`, `del_files=1` | Archive/delete a history item; by default it is archived, while `archive=0` removes it completely. |
| GET | `/api?mode=status` | Optional `skip_dashboard=1`, `calculate_performance=1` | Inspect SAB/system/server state, warnings, blocked servers, connections, folders, and load. |
| GET | `/api?mode=server_stats` | None | Check total/per-server bytes and article success/tried counters for unhealthy Usenet servers. |

## Jellyfin

**Base:** `/`  
**Auth:** documented OpenAPI security uses `Authorization: MediaBrowser Token="<api-key>"`; Jellyfin also commonly accepts `X-Emby-Token: <api-key>`. Keep the token out of URLs/logs. JSON field casing below follows the stable spec's default PascalCase profile.

| Method | Path | Key query/body parameters | Diagnostic use |
|---|---|---|---|
| GET | `/Items` | `searchTerm`, `recursive=true`, `includeItemTypes=Episode,Movie,Series`, `fields=ProviderIds,Path,MediaStreams`, optional `userId`, `parentId`, `limit` | Search library items by name and return IDs/provider IDs/paths needed for later calls. |
| GET | `/Items` | Name search plus `fields=ProviderIds`; filter returned `ProviderIds` client-side for the exact TVDB/TMDB/IMDb value | **Direct provider-ID predicate is unverified:** the fetched stable OpenAPI does not expose `AnyProviderIdEquals`; use a narrowed search and exact client-side match rather than relying on undocumented query syntax. |
| GET | `/Items/{itemId}` | Optional `userId` | Read item metadata, path, provider IDs, file/container data, and any included media sources/streams. |
| GET | `/Items/{itemId}/PlaybackInfo` | `itemId`, optional `userId` | Probe playable media sources. Inspect `MediaSources[]` and `MediaStreams[]`: stream `Type`, `Codec`, `Language`, `Index`, default/forced/external flags, channels/layout, bitrate, dimensions, profile, bit depth, HDR/color data; also direct-play/transcode support and errors. |
| POST | `/Items/{itemId}/PlaybackInfo` | Optional query controls (`mediaSourceId`, stream indexes, bitrate/direct-play flags); body is `PlaybackInfoDto` with device profile/client playback capabilities | Reproduce a client-specific playback decision or understand why Jellyfin transcodes/rejects a file. |
| POST | `/Items/{itemId}/Refresh` | `metadataRefreshMode`, `imageRefreshMode`, `replaceAllMetadata=false`, `replaceAllImages=false`, `regenerateTrickplay=false` | Refresh one item's metadata after wrong title/language/artwork or an external file change. |
| POST | `/Library/Refresh` | No parameters | Start a full library scan after files were added/moved outside Jellyfin; potentially expensive. |
| GET | `/Sessions` | Optional `activeWithinSeconds`, `deviceId`, `controllableByUserId` | Find active/recent clients and playback. Inspect `IsActive`, `LastActivityDate`, `NowPlayingItem`, `PlayState`, and `TranscodingInfo` for stalls/transcode failures. |

## Sources and implementation notes

- Sonarr OpenAPI: `https://raw.githubusercontent.com/Sonarr/Sonarr/develop/src/Sonarr.Api.V3/openapi.json`
- Radarr OpenAPI: `https://raw.githubusercontent.com/Radarr/Radarr/develop/src/Radarr.Api.V3/openapi.json`
- Sonarr/Radarr command body properties were additionally checked against their current command classes in the respective GitHub repositories because the generic `/command` OpenAPI schema does not enumerate concrete command payloads.
- SABnzbd API wiki: `https://sabnzbd.org/wiki/configuration/5.0/api` (the supplied `/wiki/advanced/api` URL redirects/moves here).
- Jellyfin stable OpenAPI: `https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json`
- IDs are service-local unless explicitly identified as TVDB/TMDB/provider IDs. Resolve external IDs to local IDs before querying files, history, commands, or playback.
- Queue/history responses vary somewhat by service version and download state. Code defensively around absent optional fields, and preserve raw status/error payloads in diagnostic evidence.
