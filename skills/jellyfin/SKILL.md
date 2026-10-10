---
name: jellyfin
description: Diagnose Jellyfin identity, streams, subtitles, playback, visibility, and metadata. Load for library or playback reports, including missing media after Arr import.
---

# Jellyfin

`POST /Items/{itemId}/Refresh` through `jellyfin_request` updates metadata,
indexing, and probing, not bytes or tracks. Re-read identity/media afterward.
For a wrong match, look up candidates with `POST /Items/RemoteSearch/{Movie|Series}`
and apply one with `POST /Items/RemoteSearch/Apply/{itemId}`.

## Mapping and reads

- Search: `GET /Items?searchTerm={query}&recursive=true&limit=10`
- Libraries: `GET /Library/VirtualFolders`
- Children: `GET /Items?parentId={itemId}&recursive=true&limit=50`
- Identity/media: `GET /Items?Ids={itemId}&Fields=MediaSources,Path,ProviderIds`
- Movie by TMDB: `GET /Items?recursive=true&IncludeItemTypes=Movie&AnyProviderIdEquals=Tmdb.{tmdbId}&Fields=MediaSources,Path,ProviderIds&limit=10`
- User/session diagnostics: `GET /Users`, `GET /Users/{userId}/Views`,
  `GET /Users/{userId}/Items/{itemId}`,
  `GET /UserItems/{itemId}/UserData?userId={userId}`, `GET /Sessions`

Bare `GET /Items/{itemId}` returns HTTP 400 here without user context. Use
`Ids=`. Match provider ID and type; title/year is only a verified fallback.
For TV, descend series → season → exact episode. Sample only within reported
scope. Use user endpoints only for visibility, progress, favorites, or
preference symptoms.

Inspect the selected version's path, container, runtime, size, bitrate, codec,
profile, bit depth, and HDR. Check every audio/subtitle stream's language,
title, default, and forced flags. Jellyfin may play a different version than
the file inspected in Arr.

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
