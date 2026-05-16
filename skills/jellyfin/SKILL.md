---
name: jellyfin
description: Use when diagnosing Jellyfin library availability, metadata, item lookup, playback, or refresh problems for a Jellyseerr issue.
---

# Jellyfin Skill

- Use Jellyfin tools to verify whether media exists in the library before claiming an item is available or missing.
- Search by title first when only human-readable media names are available.
- Fetch a specific item when an item id is known from another tool result.
- For questions about missing audio, subtitle, codec, or playback tracks, use `jellyfin_get_item_media_info` for a movie or episode item and inspect `audio_tracks` / `subtitle_tracks`.
- For show- or season-level audio questions, use `jellyfin_get_child_media_info` on the series or season item and compare the affected episodes instead of assuming one episode represents the whole show.
- Local Jellyfin media stream metadata is the source of truth for what tracks are actually available to play.
- Use `jellyfin_refresh_item` only when metadata appears stale or an item exists but Jellyseerr/Seerr availability looks out of date.
- Validation means checking the item state again after any refresh action.
