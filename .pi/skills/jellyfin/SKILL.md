---
name: jellyfin
description: Use when diagnosing Jellyfin library availability, metadata, media streams, item lookup, playback, or refresh problems for a Seerr issue.
---

# Jellyfin Skill

Use `jellyfin_request` with relative Jellyfin API paths. Every request needs `purpose`. Use GET first. Non-GET requests require `safety_level: narrow_mutation` and `safety_reason`.

## Common reads

- Search items: `GET /Items?searchTerm={query}&recursive=true&limit=10`
- List libraries: `GET /Library/VirtualFolders`
- List items under parent/library: `GET /Items?parentId={itemId}&recursive=true&limit=50`
- Item by id with media sources: `GET /Items/{itemId}?Fields=MediaSources,Path,ProviderIds`
- User list when admin/operator context allows it: `GET /Users`
- User views: `GET /Users/{userId}/Views`
- User-scoped item: `GET /Users/{userId}/Items/{itemId}`
- User item data: `GET /UserItems/{itemId}/UserData?userId={userId}`
- Active sessions: `GET /Sessions`

## Narrow mutations

- Refresh an item only when metadata appears stale or an item exists but Seerr availability looks out of date: `POST /Items/{itemId}/Refresh?Recursive=true&ImageRefreshMode=Default&MetadataRefreshMode=Default`.
- Validate refreshes by reading the item or Seerr availability again.

## Diagnostic rules

- Verify whether media exists in Jellyfin before claiming an item is available or missing.
- For missing audio, subtitle, codec, or playback-track reports, Jellyfin media stream metadata is the source of truth for what can actually be played.
- For show/season-level track questions, inspect child episode media info instead of assuming one episode represents the whole show.
- Use user-scoped item/views only when the issue depends on a specific user's visibility, playback position, played status, or favorites.
- Do not expose private user data in final Seerr comments.
