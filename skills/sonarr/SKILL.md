---
name: sonarr
description: Use when diagnosing or safely fixing Sonarr series queue, refresh, or TVDB-linked series issues from Jellyseerr.
---

# Sonarr Skill

- Use Sonarr tools for series issues, especially payloads with `media_type` tv or a TVDB id.
- Lookup the series by TVDB id before queue actions.
- Read the Sonarr queue when the issue suggests stuck, failed, missing, or delayed episode downloads/imports.
- If a fresh release failed because it was corrupt, unpack failed, or download/import failed and Sonarr blocklisted it, inspect `sonarr_get_blocklist`.
- Only delete a blocklist item when it clearly matches the affected series/episode/release and the blocklist reason explains the missing episode.
- After clearing the matching blocklist entry, trigger `sonarr_search_episode` for the specific episode id, not a broad series search.
- Use `sonarr_get_episodes_by_series_id` to find the exact episode id when needed.
- Use `sonarr_search_episode` for one missing episode, `sonarr_search_season` when a whole season is missing, and `sonarr_search_series` only when the issue affects the whole series or the user explicitly asks for a broad search.
- Prefer the narrowest search that matches the issue to avoid unnecessary indexer load and accidental downloads.
- Other safe fixes are limited to retrying a known queue item and refreshing a known series.
- Validate by reading the queue/blocklist/episode state again after the action.
