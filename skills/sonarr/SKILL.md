---
name: sonarr
description: Use when diagnosing or safely fixing Sonarr series queue, refresh, or TVDB-linked series issues from Jellyseerr.
---

# Sonarr Skill

- Use Sonarr tools for series issues, especially payloads with `media_type` tv or a TVDB id.
- Lookup the series by TVDB id before queue actions.
- Read the Sonarr queue when the issue suggests stuck, failed, missing, or delayed episode downloads/imports.
- For questions about an episode's downloaded file metadata, use `sonarr_get_episode_file` when an `episodeFileId` is known, or `sonarr_get_episode_files_by_series_id` to inspect file quality, languages, and Sonarr `mediaInfo` across a series or season.
- For playback-track questions such as "why is German audio missing?", prefer Jellyfin media-info tools to verify actual streams, then use Sonarr file metadata to explain how the release was selected or imported.
- For playback-track diagnostics, do not call `sonarr_search_episode`, `sonarr_search_season`, `sonarr_search_series`, or `sonarr_refresh_series` unless the user explicitly asks for a replacement/fix. These tools can change queue state.
- Use `web_search` after local tools establish that the requested track is absent from imported files and the answer depends on external release/language availability, for example whether German audio exists for later episodes or whether only English releases are currently available.
- If a fresh release failed because it was corrupt, unpack failed, or download/import failed and Sonarr blocklisted it, inspect `sonarr_get_blocklist`.
- Only delete a blocklist item when it clearly matches the affected series/episode/release and the blocklist reason explains the missing episode.
- After clearing the matching blocklist entry, trigger `sonarr_search_episode` for the specific episode id, not a broad series search.
- Use `sonarr_get_episodes_by_series_id` to find the exact episode id when needed.
- Use `sonarr_search_episode` for one missing episode, `sonarr_search_season` when a whole season is missing, and `sonarr_search_series` only when the issue affects the whole series or the user explicitly asks for a broad search.
- Prefer the narrowest search that matches the issue to avoid unnecessary indexer load and accidental downloads.
- Other safe fixes are limited to retrying a known queue item and refreshing a known series.
- Validate by reading the queue/blocklist/episode state again after the action.
