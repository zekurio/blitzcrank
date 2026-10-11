---
name: seerr
description: Triage Seerr issues, map media identity, and check or create requests. Load for every Seerr webhook or issue, request, user, or quota question.
---

# Seerr issue handling

The host supplies a fresh issue read with comments. Fetch again only if
truncated or newer state is needed. Seerr establishes reporter and media
identity, not file contents. Issue status, request status, and availability
are separate states.

The host posts your final message as the comment. Issue status is the
reporter's to change: neither you nor the host touches it, and the comment
does not mention it or ask anyone to resolve the issue. After a verified fix,
say in the comment what shows it worked.

## Reads

Load the tools you need with `tool_search`, then call them directly.

- Issue: `seerr_issue` with `issueId`. Comments, media identity, and reporter.
- Request: `seerr_request` with `requestId`. Status, seasons, and requester.
- Search: `seerr_search` with `query`. Each match has `mediaType`, `tmdbId` or
  `tvdbId`, title, and year.
- User: `seerr_user` with `userId`. Includes a permissions summary.
- Quota: `seerr_quota` with `userId`.
- Anything without a tool: `seerr_raw` with a GET `path` under `/api/v1`.

## Triage and mapping

Read the report, comments, reporter, IDs, and affected season/episode. Do not
make changes for a resolved issue without explicit reason.

Map movie TMDB to Radarr and Jellyfin provider identity. Map TV TVDB to Sonarr,
then the exact episode and Jellyfin hierarchy. Never interchange TMDB/TVDB.
Title/year is only a verified fallback. Clarify ambiguous TV scope before
broad or destructive action.

Read the owning Arr and Jellyfin before mutation. Follow exact Arr download
IDs into SAB only for handoff problems. Replace through Arr only for verified
wrong, damaged, or missing content.

Issue type guides investigation, not diagnosis:

- VIDEO needs file, playback, and transcode evidence.
- AUDIO needs all tracks and expected behavior.
- SUBTITLES needs embedded/sidecar flags, selection, and client support.
- OTHER needs metadata, availability, request, or pipeline classification.

Subjective or client-specific symptoms need reporter confirmation.

## Request mutation

Create a request only when the user explicitly asks to request media. No Arr
tool adds a series or movie, so a Seerr request is how media gets added.
Search first and verify TMDB identity, media type, existing requests, and TV
seasons. If a Seerr reporter identity exists, check that user's permissions and
quota, and pass their `userId` so the request is theirs.

A write acts on its first call and returns `summary`, `effects`, `warnings`,
and a `verification` re-read of the request.

- `seerr_create_request` takes `mediaType`, `mediaId` (the TMDB ID, for TV
  too), optional `seasons`, and optional `userId`. Check the media's status in
  `seerr_search` first: nothing asks you to confirm, and existing requests for
  the same media come back only as `warnings` once the request is made.
- `seerr_retry_request` takes `requestId`. Use it for a request that failed to
  reach its Arr, after the cause is fixed.

Approving, declining, or deleting requests is admin work.
