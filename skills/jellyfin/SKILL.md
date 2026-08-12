---
name: jellyfin
description: Diagnose Jellyfin library identity, availability, media streams, subtitles, playback, transcoding, user visibility, and stale metadata. Load for Seerr reports involving wrong language, missing subtitles, wrong metadata, unavailable media, or playback failure after Arr import.
---

# Jellyfin

Use read-only `jellyfin_request` with `purpose` and a relative GET path. The only
mutation is `jellyfin_refresh_item`; it requires `reason` and an `itemId`
previously returned by a Jellyfin read on this issue. Inspect its `verification`
and re-read affected state. Issue runs are uncapped; an automation is capped
only when its definition declares a budget. Refresh updates metadata/indexing
and probing; it cannot repair bytes or add tracks. No broad-library refresh is
exposed.

## Mapping and reads

Seerr supplies provider identity; Sonarr/Radarr own files; Jellyfin identifies,
probes, and serves them. Client codec, bitrate, subtitle, preference, or
transcode behavior can still prevent playback of a valid file.

Useful reads:

- Search: `GET /Items?searchTerm={query}&recursive=true&limit=10`
- Libraries/children: `GET /Library/VirtualFolders`; then
  `GET /Items?parentId={itemId}&recursive=true&limit=50`
- Identity/media: `GET /Items?Ids={itemId}&Fields=MediaSources,Path,ProviderIds`
- Movie by TMDB: `GET /Items?recursive=true&IncludeItemTypes=Movie&AnyProviderIdEquals=Tmdb.{tmdbId}&Fields=MediaSources,Path,ProviderIds&limit=10`
- User/session diagnostics when appropriate: `GET /Users`,
  `GET /Users/{userId}/Views`, `GET /Users/{userId}/Items/{itemId}`,
  `GET /UserItems/{itemId}/UserData?userId={userId}`, `GET /Sessions`

Do not use bare `GET /Items/{itemId}`; this deployment returns HTTP 400 without
user context. Use `Ids=`. Map by provider ID and type; title/year is only a
verified fallback. For TV, descend series → season → exact episode and sample
multiple episodes only when the claimed scope requires it.

Inspect the selected media source/version: path, container, runtime, size,
bitrate, video codec/profile/bit depth/HDR, and every audio/subtitle stream with
language/title/default/forced flags. Jellyfin stream metadata is playback truth
after import. Inspect sessions, play method (Direct Play/Remux/Direct
Stream/Transcode), and transcode reason to separate universal from user/client
symptoms. User endpoints are only for visibility, progress, favorites, and
preference symptoms; never expose private data.

## Diagnosis

- **Wrong/missing audio:** inspect all file streams and client selection. If a
  track exists, acquisition is fine. If absent, correlate Arr evidence; refresh
  cannot add it. Arr `languages` is release-name parsing, not proof—confirm the
  actual Arr path with `media_probe`, including before import.
- **Subtitles:** inspect embedded/external tracks, format, sidecar association,
  flags, user mode, and client support. Subtitle burn-in may force transcode.
  Refresh after sidecar correction; replace only when required subtitles are
  truly absent.
- **Playback/buffering:** check client scope, selected version, codecs, HDR,
  bitrate, audio layout, subtitle selection, transcode reason, hardware
  acceleration, and API-visible temporary-storage errors. Universal direct-play
  failure suggests access/bad media; client-specific failure suggests
  compatibility/transcode behavior.
- **Missing after import:** verify the exact Arr path lies under a Jellyfin
  library as Jellyfin sees it, then search by provider/path and narrowly refresh
  an existing item. If the Arr file is absent, return to Arr/SAB.
- **Wrong/stale metadata:** compare IDs, type, title/year, hierarchy, path, size,
  runtime, and streams. Refresh the affected item and re-fetch identity/media.
  Do not replace a correct file solely for metadata.

Classify indexing/identity, mount/access, stream selection,
client/transcoding, bad source, or a mixture. Multiple versions may mean
Jellyfin played a different file than Radarr's inspected file. A successful scan
does not prove playback; verify the original symptom before resolution.

Call `report_progress` first with one short public status line; later calls
rewrite it. Do not expose tool names, IDs, URLs, paths, promises, or user data.
Never call Seerr comment/resolve APIs. Use the required final directive block
beginning with `RESOLVE_ISSUE: yes|no`; when unresolved, add `REVISIT_IN` and
`REVISIT_REASON` only for a concrete, falsifiable active check. Keep the issue
open through importing, scanning, playback validation, or needed reporter
confirmation.
