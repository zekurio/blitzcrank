---
name: radarr
description: Use when diagnosing or safely fixing Radarr movie queue, refresh, or TMDB-linked movie issues from Seerr.
---

# Radarr Skill

- Use `sandbox_run_typescript` with the configured Radarr environment variables for movie issues, especially payloads with `media_type` movie or a TMDB id.
- Lookup the movie by TMDB id before queue actions.
- Fetch the Radarr movie by id when a Radarr movie id is already known from another result.
- For questions about a downloaded movie file's metadata, fetch the Radarr movie file when a `movieFileId` is known and inspect quality, languages, and Radarr `mediaInfo`.
- For playback-track questions such as "why is German audio missing?", prefer Jellyfin media-info sandbox checks to verify actual streams, then use Radarr file metadata to explain how the release was selected or imported.
- For playback-track diagnostics, do not trigger Radarr movie searches or refreshes unless the user explicitly asks for a replacement/fix. These actions can change queue state.
- Before using `web_search` for missing-track diagnostics, inspect local Radarr context first: movie history, queue, blocklist, imported file metadata, quality profile/language/custom-format evidence, and narrow release results when needed. Use web search only if that local context cannot answer whether a better local candidate exists and the answer depends on external release/provider availability.
- Read the Radarr queue when the issue suggests stuck, failed, missing, or delayed movie downloads/imports.
- If a fresh release failed because it was corrupt, unpack failed, or download/import failed and Radarr blocklisted it, inspect the Radarr blocklist.
- Only delete a blocklist item when it clearly matches the affected movie/release and the blocklist reason explains the missing movie.
- After clearing the matching blocklist entry, trigger a search for the specific movie id.
- Search the movie when a requested movie is missing, failed, blocklisted, or needs a fresh download search after a confirmed failed release.
- Do not repeatedly trigger movie searches without checking queue/history/blocklist state between attempts.
- Other safe fixes are limited to retrying a known queue item and refreshing a known movie.
- Validate by reading the queue/blocklist/movie state again after the action.
