---
name: radarr
description: Use when diagnosing or safely fixing Radarr movie queue, refresh, or TMDB-linked movie issues from Jellyseerr.
---

# Radarr Skill

- Use Radarr tools for movie issues, especially payloads with `media_type` movie or a TMDB id.
- Lookup the movie by TMDB id before queue actions.
- Use `radarr_get_movie_by_id` when a Radarr movie id is already known from another tool result.
- For questions about a downloaded movie file's metadata, use `radarr_get_movie_file` when a `movieFileId` is known and inspect quality, languages, and Radarr `mediaInfo`.
- For playback-track questions such as "why is German audio missing?", prefer Jellyfin media-info tools to verify actual streams, then use Radarr file metadata to explain how the release was selected or imported.
- Use web search only after local tools establish the stored file's tracks, for example to check whether the requested audio language exists for that title or release.
- Read the Radarr queue when the issue suggests stuck, failed, missing, or delayed movie downloads/imports.
- If a fresh release failed because it was corrupt, unpack failed, or download/import failed and Radarr blocklisted it, inspect `radarr_get_blocklist`.
- Only delete a blocklist item when it clearly matches the affected movie/release and the blocklist reason explains the missing movie.
- After clearing the matching blocklist entry, trigger `radarr_search_movie` for the specific movie id.
- Use `radarr_search_movie` when a requested movie is missing, failed, blocklisted, or needs a fresh download search after a confirmed failed release.
- Do not repeatedly trigger movie searches without checking queue/history/blocklist state between attempts.
- Other safe fixes are limited to retrying a known queue item and refreshing a known movie.
- Validate by reading the queue/blocklist/movie state again after the action.
