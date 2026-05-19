---
name: sonarr
description: Use when diagnosing or safely fixing Sonarr series queue, refresh, or TVDB-linked series issues from Seerr.
---

# Sonarr Skill

- Use `sandbox_run_typescript` with the configured Sonarr environment variables for series issues, especially payloads with `media_type` tv or a TVDB id.
- Lookup the series by TVDB id before queue actions.
- Read the Sonarr queue when the issue suggests stuck, failed, missing, or delayed episode downloads/imports.
- For questions about an episode's downloaded file metadata, fetch the relevant Sonarr episode file when an `episodeFileId` is known, or inspect episode files by series and season to check quality, languages, and Sonarr `mediaInfo`.
- For playback-track questions such as "why is German audio missing?", prefer Jellyfin media-info sandbox checks to verify actual streams, then use Sonarr file metadata to explain how the release was selected or imported.
- For playback-track diagnostics, do not trigger Sonarr episode/season/series searches or refreshes unless the user explicitly asks for a replacement/fix. These actions can change queue state.
- Before using `web_search` for missing-track diagnostics, inspect local Sonarr context first: episode/series history, queue, blocklist, imported file metadata, quality profile/language/custom-format evidence, and narrow release results when needed. Use web search only if that local context cannot answer whether a better local candidate exists and the answer depends on external release/provider availability.
- If a fresh release failed because it was corrupt, unpack failed, or download/import failed and Sonarr blocklisted it, inspect the Sonarr blocklist.
- Only delete a blocklist item when it clearly matches the affected series/episode/release and the blocklist reason explains the missing episode.
- After clearing the matching blocklist entry, trigger a search for the specific episode id, not a broad series search.
- Fetch episodes by series id to find the exact episode id when needed.
- Search one episode for one missing episode, one season when a whole season is missing, and the series only when the issue affects the whole series or the user explicitly asks for a broad search.
- Prefer the narrowest search that matches the issue to avoid unnecessary indexer load and accidental downloads.
- Other safe fixes are limited to retrying a known queue item and refreshing a known series.
- Validate by reading the queue/blocklist/episode state again after the action.
