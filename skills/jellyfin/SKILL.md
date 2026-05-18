---
name: jellyfin
description: Use when diagnosing Jellyfin library availability, metadata, item lookup, playback, or refresh problems for a Seerr issue.
---

# Jellyfin Skill

- Use `sandbox_run_typescript` with the configured Jellyfin environment variables to verify whether media exists in the library before claiming an item is available or missing.
- Search by title first when only human-readable media names are available.
- Fetch a specific item when an item id is known from another tool result.
- List libraries/items when you need to inspect library structure, enumerate children, or narrow by parent/item type.
- List/find/fetch users when an issue depends on a specific Jellyfin account.
- Fetch user views to confirm which libraries a user can see.
- Fetch an item from the user's perspective when diagnosing account-specific item state such as played status, favorites, playback position, resume data, play count, or user-scoped visibility.
- Fetch item user data when you only need the per-user playback/favorite/resume record for a known item.
- Inspect sessions for current Jellyfin playback state.
- For questions about missing audio, subtitle, codec, or playback tracks, fetch media info for a movie or episode item and inspect audio/subtitle streams.
- For show- or season-level audio questions, fetch child media info on the series or season item and compare the affected episodes instead of assuming one episode represents the whole show.
- Local Jellyfin media stream metadata is the source of truth for what tracks are actually available to play.
- Refresh an item only when metadata appears stale or an item exists but Seerr availability looks out of date.
- Validation means checking the item state again after any refresh action.
