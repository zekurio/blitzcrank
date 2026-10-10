---
name: seerr
description: Triage Seerr issues, map media identity, and check or create requests. Load for every Seerr webhook or issue, request, user, or quota question.
---

# Seerr issue handling

The host supplies a fresh issue read with comments. Fetch again only if
truncated or newer state is needed. Seerr establishes reporter and media
identity, not file contents. Issue status, request status, and availability
are separate states.

## Reads

- Issue: `GET /api/v1/issue/{issueId}`
- Request: `GET /api/v1/request/{requestId}`
- Search: `GET /api/v1/search?query={query}`
- User: `GET /api/v1/user/{userId}`
- Quota: `GET /api/v1/user/{userId}/quota`

## Triage and mapping

Read the report, comments, reporter, IDs, and affected season/episode. Do not
reopen or mutate a resolved issue without explicit reason.

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

Create requests with `POST /api/v1/request` only when the user explicitly asks
to request media. Prefer it over direct Arr additions. Search first and verify
TMDB identity, media type, existing requests, and TV seasons. If a Seerr
reporter identity exists, check that user's permissions and quota. Re-read the
created request afterward. Approving, declining, or deleting requests is admin
work.
