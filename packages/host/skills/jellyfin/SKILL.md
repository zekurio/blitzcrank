---
name: jellyfin
description: Diagnose Jellyfin identity, streams, subtitles, playback, visibility, and metadata. Load for library or playback reports, including missing media after Arr import.
---

# Jellyfin

## Mapping and reads

Load the tools you need with `tool_search`, then call them directly. Put
independent reads in one response. To reach one episode, walk series → season
→ episode with `jellyfin_children`.

- Search: `jellyfin_search` with `term`, optional `includeItemTypes`.
- Libraries: `jellyfin_libraries`.
- Children: `jellyfin_children` with `parentId`.
- Identity/media: `jellyfin_items` with `ids`. Returns `MediaSources`, `Path`,
  and `ProviderIds` by default.
- By provider ID: `jellyfin_by_provider_id` with `provider`, `id`, and
  `itemType`.
- User/session diagnostics: `jellyfin_users`, `jellyfin_sessions`, and
  `jellyfin_user_item` with `userId` and `itemId`.
- Match candidates: `jellyfin_remote_search` with `itemType` and `itemId` or
  `searchInfo`. It queries metadata providers and changes nothing.
- Anything without a tool: `jellyfin_raw` with a GET `path`, for example a
  user's views or an item's user data. Bare `/Items/{itemId}` returns HTTP 400
  here without user context; use `jellyfin_items`.

Match provider ID and type; title/year is only a verified fallback. For TV,
descend series → season → exact episode. Sample only within reported scope.
Use user reads only for visibility, progress, favorites, or preference
symptoms.

Inspect the selected version's path, container, runtime, size, bitrate, codec,
profile, bit depth, and HDR. Check every audio/subtitle stream's language,
title, default, and forced flags. Jellyfin may play a different version than
the file inspected in Arr.

## Writes

A write acts on its first call. It reads the item first, so an item that does
not exist fails with nothing written. The result names the item, its type, and
its path in `summary` and `effects`, lists `warnings`, and carries a
`verification` re-read of the item. Confirm identity with a read before you
write.

- `jellyfin_refresh_item` takes `itemId` and optional `metadataRefreshMode`,
  `imageRefreshMode`, `replaceAllMetadata`, and `replaceAllImages`. A refresh
  updates metadata, indexing, and probing, not bytes or tracks. Leave the two
  `replaceAll` flags off unless the stored metadata or artwork is itself wrong.
  The refresh runs in the background, so re-read identity/media afterward.
- `jellyfin_apply_remote_search` fixes a wrong match. Read
  `jellyfin_remote_search` candidates, pick one by provider ID, and pass it
  unchanged as `searchResult` with the `itemId`. It replaces all of the item's
  metadata, and for a series every season and episode is refreshed too.

## Diagnosis

- For audio, check all streams and client selection. An existing track needs
  no acquisition. Arr `languages` comes from release-name parsing, not streams.
  Probe the actual Arr file, including before import.
- For subtitles, check embedded/external tracks, format, sidecar association,
  flags, user mode, and client support. Burn-in may force transcoding. Refresh
  after sidecar correction. Replace only if required subtitles are truly absent.
- For playback, check sessions, play method, transcode reason, audio layout,
  subtitle selection, hardware acceleration, and API-visible temporary-storage
  errors. Universal direct-play failure suggests access or bad media.
  Client-specific failure suggests compatibility or transcoding.
- For missing media after import, verify the Arr path is under a library as
  Jellyfin sees it. Search by provider/path and refresh an existing item
  narrowly. If the Arr file is absent, return to Arr/SAB.
- For stale metadata, compare identity, hierarchy, and file evidence before
  refreshing. Do not replace a correct file solely for metadata.

A successful scan does not prove playback. Verify the original symptom.
