---
name: jellyfin
description: Diagnose Jellyfin identity, streams, subtitles, playback, visibility, and metadata. Load for library or playback reports, including missing media after Arr import.
---

# Jellyfin

## Mapping and reads

Load the tools you need with `tool_search`, then call them directly. Put
independent reads in one response. To reach one episode, walk series → season
→ episode with `jellyfin_children`.

- Search: `jellyfin_search` with `term`, optional `includeItemTypes` (`Movie`,
  `Series`, `Season`, `Episode`, `BoxSet`).
- Libraries: `jellyfin_libraries`.
- Children: `jellyfin_children` with `parentId`. Each child carries
  `IndexNumber` and `LocationType`; `Virtual` is a placeholder without a file.
  Jellyfin picks the order, so go by `IndexNumber`. Follow `nextStartIndex`
  with `startIndex`.
- Identity/media: `jellyfin_items` with `ids`. Returns `Path`, `LocationType`,
  `ProviderIds`, and `MediaSources` with their streams. `notReturned` names
  every ID Jellyfin has no item for, and `notListed` the ones to read again.
  An item with more versions or tracks than one result holds is listed alone
  as far as it fits and carries `mediaNext`. Read that ID again by itself with
  `mediaSourceIndex` and `streamStartIndex` from it, until `mediaNext` is
  gone. `MediaStreamsTotal` on a source means its stream list is partial.
- Metadata: `jellyfin_item_detail` with `itemId`. Overview, dates, status,
  ratings, genres, tags, lock state, and `People` in Jellyfin's order.
  Repeated cast entries are kept, and `People.repeated` counts them over the
  whole list; it is `null` when an entry has no Id to count by. Follow
  `People.nextStartIndex` with `peopleStartIndex`.
- By provider ID: `jellyfin_by_provider_id` with `provider` (`Tmdb`, `Tvdb`,
  or `Imdb`), `id`, and `itemType`.
- Server: `jellyfin_server_info` for the version and the restart, shutdown,
  and update flags.
- Users and sessions: `jellyfin_users`, `jellyfin_sessions`.
- Match candidates: `jellyfin_remote_search`. See Writes.

A `null` field is one Jellyfin did not send. It is not evidence that the
thing is absent. `partial` and `truncated` say what a result left out.

Match provider ID and type; title/year is only a verified fallback. For TV,
descend series → season → exact episode. Sample only within reported scope.

Inspect the selected version's path, container, runtime, size, bitrate, codec,
profile, bit depth, and HDR range. Check every audio/subtitle stream's
language, title, default, and forced flags. Jellyfin may play a different
version than the file inspected in Arr.

## One user's view

Pass `userId` to `jellyfin_item_detail` or `jellyfin_children` only for
visibility, progress, favorites, or preference symptoms. Take the ID from the
reporter's Seerr record, `jellyfinUserId` in `seerr_issue` or `seerr_user`, or
from `jellyfin_users`. Never pick a user by display name.

- `jellyfin_item_detail` adds `userView`: whether Jellyfin returns the item to
  that user, and if so their played state, play count, position, favorite
  flag, last play, and child counts.
- `jellyfin_children` lists what Jellyfin returns to that user, each child
  with its played state. A series then lists no season without a file unless
  the user displays missing episodes, so compare with the read without
  `userId` before calling a season missing.
- `returned: false` or `parentReturned: false` means Jellyfin answered 404 to
  that user, and separate reads found the item and the user. Library access
  and parental rules are the usual causes, but the answer names none, and an
  item or user that changed between those reads looks the same. Read the
  user's `Policy` in `jellyfin_users` and read again before naming a cause.

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
- `jellyfin_apply_remote_search` fixes a wrong match on a `Movie`, `Series`,
  `BoxSet`, or `Trailer`. For a season or episode, match its series.
  1. Read candidates with `jellyfin_remote_search` and the `itemId`. Alone, it
     searches the item's own name and year. Pass `name` and `year` to search
     for the right title instead.
  2. Read `jellyfin_remote_search` again with the `itemId` and the chosen
     candidate's `provider` and `providerId`. That is the search the write
     runs, so it shows exactly what would be applied.
  3. Call `jellyfin_apply_remote_search` with the same `itemId`, `provider`,
     and `providerId`. It searches the providers again and applies only the
     candidate they return for that ID now. No candidate, or several different
     ones, fails with nothing written; for several, pass the
     `searchProviderName` of the one you mean.

  It replaces the item's provider IDs with the candidate's, which `effects`
  shows in full, and replaces all of its metadata. For a series every season
  and episode is refreshed too. `replaceAllImages` defaults to true.

  Jellyfin answers only after that refresh, so the call waits for it. A long
  series can outlast the wait. The call then ends with an unknown outcome,
  which stops the run for operator review: the rematch may still be running
  or finished, and nothing retries it.

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
- For a client that fails on one title, read `jellyfin_item_detail` for what
  that title carries that others do not, such as repeated cast entries, and
  `jellyfin_server_info` for the server version.
- For missing media after import, verify the Arr path is under a library as
  Jellyfin sees it. Search by provider/path and refresh an existing item
  narrowly. If the Arr file is absent, return to Arr/SAB.
- For stale metadata, compare identity, hierarchy, and file evidence before
  refreshing. `LockData` and `LockedFields` in `jellyfin_item_detail` show
  what a refresh will not change. Do not replace a correct file solely for
  metadata.

A successful scan does not prove playback. Verify the original symptom.
