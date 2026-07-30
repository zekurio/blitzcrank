---
name: jellyfin
description: Diagnose Jellyfin library identity, availability, media streams, subtitles, playback, transcoding, user visibility, and stale metadata. Load for Seerr reports involving wrong language, missing subtitles, wrong metadata, unavailable media, or playback failure after Arr import.
---

# Jellyfin

Use the read-only `jellyfin_request` with relative Jellyfin API paths; it accepts only `purpose` and `path` and performs GETs. Refreshes use the dedicated `jellyfin_refresh_item` tool. Each refresh requires a `reason`, its `itemId` must first appear in a Jellyfin read during the current run, and it counts toward the per-run maximum of 5 mutations.

## Terminology

- **Library/item/provider IDs**: Jellyfin hierarchy and external TMDB/TVDB/IMDb/AniDB identities used to disambiguate media.
- **Media source/stream**: File/version metadata and probed video, audio, subtitle, or attachment tracks.
- **Direct Play/Remux/Direct Stream/Transcode**: Increasing levels of server-side adaptation.
- **Refresh/scan**: Updates library, metadata, images, or media probing; it cannot repair media bytes or add missing tracks.
- **User-scoped state**: Visibility, playback position, played status, and favorites that may differ by user.

## How it fits the stack

1. Seerr provides reporter context and provider IDs.
2. Sonarr/Radarr own acquisition and canonical files; SABnzbd and possibly Anvil precede import.
3. Jellyfin scans those paths, identifies items, probes streams, and serves clients.
4. A valid file may fail on one client because of codec, bitrate, subtitles, preferences, or transcoding; a bad source must be handled through the Arr.

## Common reads

- Search: `GET /Items?searchTerm={query}&recursive=true&limit=10`
- Libraries: `GET /Library/VirtualFolders`
- Children: `GET /Items?parentId={itemId}&recursive=true&limit=50`
- Item with identity/media: `GET /Items?Ids={itemId}&Fields=MediaSources,Path,ProviderIds`
- By provider identity, the most reliable way in from a `tmdbId`: `GET /Items?recursive=true&IncludeItemTypes=Movie&AnyProviderIdEquals=Tmdb.{tmdbId}&Fields=MediaSources,Path,ProviderIds&limit=10`
- Users, when admin/operator context permits: `GET /Users`
- User views: `GET /Users/{userId}/Views`
- User item: `GET /Users/{userId}/Items/{itemId}`
- User data: `GET /UserItems/{itemId}/UserData?userId={userId}`
- Sessions: `GET /Sessions`

Do not use bare `GET /Items/{itemId}`: without a user context this deployment answers HTTP 400, so it costs a call and tells you nothing. Use the `Ids=` list form above, which needs no user.

## Diagnostic workflow

1. Fetch the live Seerr issue, then locate Jellyfin media by provider ID and type. Use title/year only as a verified fallback; missing provider IDs are missing evidence, not permission to guess.
2. For TV, descend series → season → exact episode. For show/season track questions, inspect multiple child episodes rather than treating one as universal.
3. Fetch media sources and record path, versions, container, runtime, size, bitrate, video codec/profile/bit depth/HDR, audio tracks, subtitle tracks, and flags.
4. Jellyfin media-stream metadata is the source of truth for what can actually be played. Check which version and stream the client selected.
5. Inspect sessions/play method and transcode reason when available; determine whether the issue is universal or user/client-specific.
6. Use user-scoped endpoints only for visibility, progress, played state, favorites, or preference-dependent symptoms, and never expose private user data in final communications.
7. Classify metadata/indexing, mount/access, stream selection, client compatibility/transcoding, or bad source. Correlate bad-source findings with Sonarr/Radarr file/history/profile evidence.
8. Refresh only when stale metadata or indexing is plausible. Check the mutation result's `verification` field, then re-read the item and/or Seerr availability when needed to confirm downstream state.

## Allowed typed mutation

- Refresh one existing item when metadata is stale or Seerr availability appears outdated: call `jellyfin_refresh_item` with a `reason` and the exact `itemId` fetched this run.
- Inspect the returned `verification` field and validate by reading the item or Seerr availability again. No broad library refresh tool is exposed.

## Playbooks

### Wrong language or missing audio

Inspect all audio streams, labels, codec, channels, language, and default flags. Check user/client selection if the desired track exists. If absent, treat it as a release problem and use Sonarr/Radarr evidence; metadata refresh cannot add audio. Do not accept Sonarr/Radarr `languages` as a contradicting signal — it is parsed from the release name; confirm the file itself with `media_probe` on the Arr file path (see the `media-probe` skill), which also works before import when the item is not in the library yet.

### Missing subtitles

Inspect embedded and external streams, formats, language, forced/default flags, and sidecar association evidence. Check user subtitle mode and client support; burn-in may trigger transcoding. Refresh after a sidecar correction, but replace/acquire another source only when the required subtitles are truly absent.

### Won't play, buffers, or heavy transcode

Determine client scope and play method. Inspect codecs, HDR, bitrate, audio layout, subtitle selection, transcode reason, hardware acceleration, and temporary-storage errors available through APIs. Universal direct-play failure suggests access or bad media; client-specific incompatibility suggests client/transcode behavior. Verify actual playback after correction.

### Missing after import

Confirm the Arr imported the exact path, that it belongs under a configured Jellyfin library as seen by Jellyfin, and that API evidence supports mapping/permission visibility. Refresh the existing/narrow item when appropriate and search by provider ID and path. If the Arr file is absent, return to the Arr/SAB/Anvil flow.

### Wrong metadata or item match

Compare provider IDs, type, title, year, season/episode, and path. Refresh the affected item; do not replace a correct file solely for metadata. Re-fetch identity and hierarchy afterward.

### Stale media information after replacement

Compare path, size, modification evidence, streams, and runtime against the replacement. Refresh the item to re-probe, then verify changed streams and playback.

## Jellyfin versus file problem

- **Jellyfin/client**: wrong identification, stale scan, inaccessible mount, preferences, client codec limits, or FFmpeg/transcode failure.
- **File/release**: missing track, corrupt/truncated media, wrong content, malformed timestamps, or universal failure.
- **Mixed**: valid but exotic codec/subtitle media; decide between fixing transcoding and requesting a more compatible release.

## Verification and communication

- Call `report_progress` as the first action, with one short public, user-facing status sentence; do not include internal tool names, IDs, URLs, or promises. It is one live status line: later calls rewrite it in place and your final comment replaces it.
- A successful scan does not prove playback.
- Do not call Seerr comment/resolve APIs. Final output must use `RESOLVE_ISSUE: yes|no`; unresolved work may add `REVISIT_IN` and `REVISIT_REASON`.
- Verify the affected item and original symptom before resolution.

## Pitfalls

- Never match solely by title or assume the first stream is selected.
- Multiple versions may make Jellyfin play a different file than Radarr's inspected file.
- Metadata refresh cannot repair corruption or create tracks.
- Jellyfin stream data only exists after import; for a not-yet-imported download, probe the file with `media_probe` instead of inferring from release names.
- Subtitle selection can force expensive video transcoding.
- Do not expose private user data.
