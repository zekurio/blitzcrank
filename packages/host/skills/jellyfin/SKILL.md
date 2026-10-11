---
name: jellyfin
description: Diagnose Jellyfin identity, streams, subtitles, playback, visibility, and metadata. Load for library or playback reports, including missing media after Arr import.
---

# Jellyfin

## Mapping and reads

Read with `jellyfin_read` inside a `codemode` script. One script can walk
series → season → episode and return only the streams you need.

```js
const matches = await tools.jellyfin_read({
  resource: "byProviderId",
  provider: "Tmdb",
  id: "603",
  itemType: "Movie",
})
const sessions = await tools.jellyfin_read({ resource: "sessions" })
return { matches, sessions }
```

- Search: `search` with `term`, optional `includeItemTypes`.
- Libraries: `libraries`.
- Children: `children` with `parentId`.
- Identity/media: `items` with `ids`. Returns `MediaSources`, `Path`, and
  `ProviderIds` by default.
- By provider ID: `byProviderId` with `provider`, `id`, and `itemType`.
- User/session diagnostics: `users`, `sessions`, and `userItem` with `userId`
  and `itemId`.
- Match candidates: `remoteSearch` with `itemType` and `itemId` or
  `searchInfo`. It queries metadata providers and changes nothing.
- Anything without a resource: `raw` with a GET `path`, for example a user's
  views or an item's user data. Bare `/Items/{itemId}` returns HTTP 400 here
  without user context; use `items`.

Match provider ID and type; title/year is only a verified fallback. For TV,
descend series → season → exact episode. Sample only within reported scope.
Use user reads only for visibility, progress, favorites, or preference
symptoms.

Inspect the selected version's path, container, runtime, size, bitrate, codec,
profile, bit depth, and HDR. Check every audio/subtitle stream's language,
title, default, and forced flags. Jellyfin may play a different version than
the file inspected in Arr.

## Writes

A write with an unknown outcome stops the run for operator review. A
completed write whose verification failed is still reported as completed.

Every write is two calls. In a script, call `jellyfin_plan` and return the
plan. Planning changes nothing, and an item that does not exist fails here. The
plan names the item, its type, and its path. Check them, then call the
`jellyfin_apply` tool directly with the `planId`. Scripts cannot call it. Apply
fails with `plan is stale: ...` when the item's identity, path, name, year, or
provider ids changed; read and plan again. It returns a `verification` re-read of the item, and a second apply of
one `planId` returns the first outcome with `replayed: true`.

```js
return await tools.jellyfin_plan({
  action: "refreshItem",
  itemId: "f27caa37e5142225",
})
```

- `refreshItem` takes `itemId` and optional `metadataRefreshMode`,
  `imageRefreshMode`, `replaceAllMetadata`, and `replaceAllImages`. A refresh
  updates metadata, indexing, and probing, not bytes or tracks. Leave the two
  `replaceAll` flags off unless the stored metadata or artwork is itself wrong.
  The refresh runs in the background, so re-read identity/media afterward.
- `applyRemoteSearch` fixes a wrong match. Read `remoteSearch` candidates, pick
  one by provider ID, and pass it unchanged as `searchResult` with the `itemId`.

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
