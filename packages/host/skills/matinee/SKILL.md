---
name: matinee
description: Diagnose what Matinee serves, map Arr records to it, fix wrong matches, missing files and tracks, stuck requests, and request new titles or seasons. Load for library, playback, track, or request reports, including missing media after Arr import.
---

# Matinee

Matinee is the media server people watch on, and where they request titles.
It sends approved requests to Radarr and Sonarr, and its file watcher scans a
library on its own a few seconds after an import. It has no issue tracker:
reports come from the conversation.

## Reads

Load the tools you need with `tool_search`, then call them directly. Put
independent reads in one response. Every read and write goes through one
Matinee account, the bot's own.

- Search: `matinee_search` with `query`, optional `kind` (`movie`, `show`)
  and `libraryId`. With `libraryId` the query matches folder paths too.
- Title: `matinee_title` with `titleId`, or `link` for a pasted Matinee link.
  It returns the match (`provider`, `providerId`, `externalIds`), the
  library-relative `path`, the seasons, and the files, each with what ffprobe
  read: video, `audio`, and `embeddedSubtitles`. `season` narrows to one
  season, `null` to the files without a season number. A long show is paged:
  follow `nextOffset` with `offset`. Read one season of a long show rather
  than all of it.
- Tracks: `matinee_tracks` with `itemId` or an episode or player `link`.
  Every audio track and every subtitle track, with `source` `sidecar` for a
  file beside the video and `embedded` for a stream inside it. A file not
  probed yet is probed first.
- By provider ID: `matinee_by_provider_id` with `kind`, `provider` (`tmdb`,
  `tvdb`), and `providerId`. See Identity.
- Libraries: `matinee_libraries`, with each library's `folders`, provider,
  language, and scan state.
- Files: `matinee_files` with `libraryId` and `query` or `folder`, optional
  `recent`. Every file a scan found, with its `relativePath` and the title it
  belongs to, or `null` before the scan grouped it. Follow `nextOffset`.
- Requests: `matinee_requests` with `requestId`, or `kind`, `provider`, and
  `providerId`. The request's `status` (`asked`, `approved`, `declined`), its
  send state `fulfilmentState` (`queued`, `sent`, `failed`), the failed
  send's `error`, its connection, progress, and `diagnostics`. `list` says
  where it sits: `waiting` for approval, `needsAttention` after a failed
  send, `onTheWay`, or `done`. `searched` says how far back it looked.
- Jobs: `matinee_jobs`, optional `queue`, such as `library-scan`,
  `media-probe`, `metadata`, or `request-dispatch`. What runs and waits, the
  latest failures, and each task's last run and next one.
- Match candidates: `matinee_matches` with `titleId`, `query`, optional
  `year`, next to the title's current match.
- Catalog: `matinee_catalog_search` with `query`, optional `kind` and
  `page`, and `matinee_catalog_details` with `kind`, `provider`,
  `providerId`, optional `libraryId`. Both answer as the bot's account:
  each title's `availability` (`here`, `asked`, `coming`, `release`,
  `unavailable`, or `none`) and its `action` (`ask` waits for approval, `add`
  is approved at once, `null` with a `disabledReason`), and in the details
  the library a request goes to, each season's state with `episodesHere` and
  `episodesAired`, the default seasons, and the account's quota in `limit`.

A `null` field is one Matinee did not send or has no value for. A cut list
says so, and a file with `probed: false` has not been probed yet: neither
proves a track or file missing.

## Paths

Keep three kinds of path apart:

- A Matinee `relativePath` or title `path` is below one of the library's
  `folders`. With several folders, it can be below any of them.
- A library's `folders` are absolute paths as the Matinee host sees them.
- `media_probe` and `media_frames` take an absolute path as this MCP server
  sees it, under its media roots. Arr paths are usually those.

The three hosts may mount the same disk at different places. Join a library
folder with a `relativePath` to get a path for the media tools only when the
folder sits under a media root as written; otherwise map it through the Arr's
path for the same file, and say when you could not.

## Identity

Map a Radarr movie by its `tmdbId` and a Sonarr series by its `tvdbId`, or
its `tmdbId` when the library uses TMDB, with `matinee_by_provider_id`.
Matinee matches on a title's provider ID and the external IDs it stored, and
names only the first title that matches. Its answer is a lead, not proof:

- Before any write, confirm the title it names: its library, and its `path`
  against the Arr's folder for the record.
- No match does not prove the title absent. A title Matinee left unmatched,
  or matched to the wrong entry, is exactly what hides from this read. Search
  by name with `matinee_search`, and the library's files by folder with
  `matinee_files`, before you call it missing.

Never interchange TMDB and TVDB IDs. Title and year are only a fallback you
verify. A library's provider decides which ID its titles carry: a TheTVDB
library's shows carry `tvdb`, a TMDB library's carry `tmdb`.

## Links

A Matinee link carries the ID in its path: `/titles/<id>`,
`/titles/<id>/seasons/<n>`, `/episodes/<id>` and `/watch/<id>` for one file,
and `/catalog/<kind>/<provider>/<id>` for a title at its provider. Pass a
title, season, episode, or player link as `link` to `matinee_title`, and an
episode or player link to `matinee_tracks`. A catalog link names a provider
ref: pass its three parts to `matinee_by_provider_id` or
`matinee_catalog_details`. No tool fetches a link; only the ID in it is used,
against this deployment's Matinee.

## Diagnosis

- Missing after import: confirm in the Arr that the file imported and where.
  Read `matinee_by_provider_id`, then `matinee_files` for the library whose
  folder holds the Arr path, with the title's folder as `folder`. A file there
  with `title: null` waits for the scan to group it. A file absent there was
  not scanned yet: read `matinee_jobs` for `library-scan`, then scan the
  library. A library on a network share Matinee does not see changes on waits
  for the timed scan, so a scan is the fix there. If the Arr has no file,
  go back to the Arr and SABnzbd.
- Wrong match: compare the title's `provider`, `providerId`, and name with
  the Arr's record. Read `matinee_matches` with the right name and year, then
  fix it with `matinee_identify_title`. A wrong match also makes the Arr's ID
  miss in `matinee_by_provider_id`.
- Stale metadata or missing episode names: `matinee_refresh_title`. Matinee
  refreshes titles with new files after a scan on its own, so check
  `refreshedAt` and `matinee_jobs` for `metadata` first.
- Missing tracks: read `matinee_tracks` for the exact file. It lists sidecar
  subtitle files too, which `matinee_title` does not. Probe the Arr's file
  with `media_probe` before calling a track absent. A track that exists
  needs no new download.
- Not probed: `probed: false` long after import means the probe has not run
  or failed: read `matinee_jobs` for `media-probe`. `matinee_tracks` probes
  the file itself.
- Stuck request: read `matinee_requests`. `waiting` waits for an admin's
  approval, which no tool gives. `needsAttention` is a failed send: read the
  `error`, check the connection's Arr, and once the cause is fixed retry it.
  `onTheWay` is in the Arr: follow the title there and in SABnzbd. A request
  counts as arrived once a scan finds a playable file.

## Writes

A write acts on its first call. It reads its target first, so one that does
not exist fails with nothing written. It returns `summary`, `effects`,
`warnings`, and a `verification` read-back.

- `matinee_scan_library` with `libraryId` queues a full scan of the library,
  the same one the timed scan runs. It returns before the scan finds
  anything: read the exact title or `matinee_files` afterwards, and say the
  file is there only once a read shows it.
- `matinee_refresh_title` with `titleId` fetches the title's metadata again
  and replaces its details, seasons, episodes, and credits. A provider ID in
  the folder name wins over the stored match, and a title without a match is
  searched by name and reset to its folder name when nothing matches. Its
  `warnings` say when either applies.
- `matinee_identify_title` with `titleId`, `providerId`, and the `query` and
  `year` that `matinee_matches` listed the candidate for. It searches again
  and matches only a candidate that search lists. The preview shows the old
  and the new match. It drops images an admin chose from the provider. When
  the folder name carries another ID, the next refresh undoes the fix:
  renaming the folder in the Arr is what lasts.
- `matinee_retry_request` with `requestId` resends an approved request whose
  send failed. The Arr may then monitor the title and search for it.
- `matinee_ask`, below.

## Adding a title

A Matinee request is the only way to add a title or a season: no Arr tool
adds one. The library's Matinee connection picks the Arr, the quality
profile, and the folder.

1. Find the title with `matinee_catalog_search`, or take the ref from
   `matinee_title`, an Arr record, or a catalog link. Confirm kind, name, and
   year with the person when several titles share a name.
2. Read `matinee_catalog_details`. For a show already here, pass the title's
   `libraryId`, so its missing seasons go to the library it is in.
3. Call `matinee_ask` with the ref, the `libraryId` from the details, and for
   a show the `seasons` the person asked for, with `future` when they want new
   seasons as they air. Without `seasons` Matinee asks for every aired season
   and the ones to come. Asking again for a show already requested adds the
   new seasons to its request.

The preview names the library, the seasons, whether the request waits for an
admin, and what is here or requested already. A title or season that is
here, declined, over the quota, or already requested fails with nothing
written, and says why.

If `matinee_ask` fails because the token lacks a permission, this deployment
cannot request titles: send the person to Matinee's own search or Discover
page to request it themselves.

## Limits

- Every request is the bot's account's, whoever asked in the conversation.
  Its group decides what may be requested and the quota, which everyone in
  the chat shares, and Matinee does not show who asked. A request waits for
  an admin's approval; no tool approves or declines one. No tool requests as
  a person.
- There is no per-person view: the tools cannot say what one person can see,
  has watched, or has asked for.
- There is no tool for live sessions. Matinee's live view names who watches
  what in the household, and every run gets every read, so it stays out.
- No tool approves, declines, or removes a request, or changes users, groups,
  libraries, or images. Those are an admin's in Matinee's settings.
