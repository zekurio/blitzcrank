---
name: jellyfin
description: Use when diagnosing Jellyfin library availability, metadata, item lookup, playback, or refresh problems for a Jellyseerr issue.
---

# Jellyfin Skill

- Use Jellyfin tools to verify whether media exists in the library before claiming an item is available or missing.
- Search by title first when only human-readable media names are available.
- Fetch a specific item when an item id is known from another tool result.
- Use `jellyfin_refresh_item` only when metadata appears stale or an item exists but Jellyseerr/Seerr availability looks out of date.
- Validation means checking the item state again after any refresh action.
