---
name: radarr
description: Use when diagnosing or safely fixing Radarr movie queue, refresh, or TMDB-linked movie issues from Jellyseerr.
---

# Radarr Skill

- Use Radarr tools for movie issues, especially payloads with `media_type` movie or a TMDB id.
- Lookup the movie by TMDB id before queue actions.
- Read the Radarr queue when the issue suggests stuck, failed, missing, or delayed movie downloads/imports.
- If a fresh release failed because it was corrupt, unpack failed, or download/import failed and Radarr blocklisted it, inspect `radarr_get_blocklist`.
- Only delete a blocklist item when it clearly matches the affected movie/release and the blocklist reason explains the missing movie.
- After clearing the matching blocklist entry, trigger `radarr_search_movie` for the specific movie id.
- Use `radarr_search_movie` when a requested movie is missing, failed, blocklisted, or needs a fresh download search after a confirmed failed release.
- Do not repeatedly trigger movie searches without checking queue/history/blocklist state between attempts.
- Other safe fixes are limited to retrying a known queue item and refreshing a known movie.
- Validate by reading the queue/blocklist/movie state again after the action.
