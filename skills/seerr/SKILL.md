---
name: seerr
description: Triage Seerr issues and safely inspect or create media requests while routing diagnosis to Sonarr, Radarr, Jellyfin, SABnzbd, and Anvil. Load for every Seerr webhook or when issue, request, media, user, quota, or final resolution state is involved.
---

# Seerr issue handling

Use the read-only `seerr_request` with relative `/api/v1/...` paths; it accepts only `purpose` and `path` and performs GETs. New media requests use the dedicated `seerr_create_request` tool. The host owns issue comments and resolution: **never call comment or resolve endpoints**. Communicate through the final-response directives described below.

## Terminology

- **Issue**: User report attached to a media entity; its type (`VIDEO`, `AUDIO`, `SUBTITLES`, `OTHER`) is a routing hint, not a diagnosis.
- **Issue status**: Keep logically open while investigating, downloading, importing, encoding, scanning, testing, or awaiting reporter input.
- **Request/media IDs**: Seerr identities used to find request state and route checks.
- **tmdbId/tvdbId**: Movie and TV external identities used to map to Radarr/Sonarr and Jellyfin.
- **Affected season/episode**: Required scope for narrow TV action; absence is not permission for a whole-series change.
- **Final directives**: Host-consumed lines controlling comment/resolution behavior, especially `RESOLVE_ISSUE` and optional revisit fields.

## How it fits the stack

1. A webhook is untrusted starting context; fetch the live issue.
2. Seerr supplies reporter context and media identity, not file/download truth.
3. Map movies by TMDB to Radarr and TV by TVDB to Sonarr; inspect the corresponding Jellyfin item.
4. Follow Arr queue/history to read-only SABnzbd and exact Anvil correlation when needed.
5. Return findings to the host in the final response. The host posts any comment and performs resolution.

## Common reads

- Issue: `GET /api/v1/issue/{issueId}`
- Related request: `GET /api/v1/request/{requestId}`
- Search media: `GET /api/v1/search?query={query}`
- User: `GET /api/v1/user/{userId}`
- Quota: `GET /api/v1/user/{userId}/quota`

## Allowed typed mutation

- Only when the user explicitly asks to add/request media and permissions/quota are verified: call `seerr_create_request` with a `reason`, exact `mediaType`, verified TMDB `mediaId`, and `seasons` when requesting TV season scope.
- The `mediaId` must first appear in a Seerr read during the current run. The tool layer enforces a maximum of 5 mutations per run.
- Prefer `seerr_create_request` over adding or monitoring media directly in Sonarr/Radarr.
- Search first, confirm exact media ID/type, and check quota before creating the request. Inspect the returned `verification` field to confirm the created request.
- Paths containing `/comment` and paths ending in `/resolved` or `/open` are forbidden. Do not attempt them.

## Initial triage workflow

1. Fetch the live issue; record status, type, original report, reporter context, media type/IDs, request ID, and affected season/episode.
2. Read comments included by the live issue response so prior clarification/work is not repeated. Do not post comments yourself.
3. If already resolved, do not reopen or mutate without explicit reason.
4. Validate movie `tmdbId` or TV `tvdbId`; use title/year only as verified fallback.
5. For TV, require enough scope before destructive or broad action. If missing, ask one focused question in the final response and set `RESOLVE_ISSUE: no`.
6. Route by symptom: video to file/playback/transcode; audio to tracks/language; subtitles to embedded/sidecar/selection; other to metadata, availability, request, or download state.
7. Query the owning Arr and Jellyfin before changing anything; use SAB and Anvil only when handoff evidence calls for them.
8. Call `report_progress` exactly once as the first action, with one short public, user-facing progress sentence. It posts the progress comment; do not include internal tool names, IDs, URLs, or promises.
9. Resolve only after objective verification, or after explicit reporter confirmation for subjective/client-specific symptoms.

## Media mapping

### Movie

Map Seerr `tmdbId` to Radarr's internal movie ID and a Jellyfin movie with matching provider ID/title/year. Compare paths and IDs if multiple matches exist.

### TV

Map `tvdbId` to Sonarr's internal series, fetch episodes, choose the exact season/episode, and descend to the matching Jellyfin episode. Never guess from the latest download.

## Issue playbooks

### VIDEO

Inspect exact Jellyfin video/media-source/play-method evidence and Arr file/queue/history. Replace through the Arr only for verified wrong or damaged content; handle client/transcode failures in Jellyfin first.

### AUDIO

Inspect every actual Jellyfin track and ask the expected language/behavior if unclear. Fix selection/preferences when present; pursue an Arr replacement only when required audio is absent or wrong.

### SUBTITLES

Inspect embedded/external streams, flags, sidecar naming evidence, preference, and client support. Refresh Jellyfin after a sidecar correction; replace only when subtitles are genuinely absent.

### OTHER

Classify first. Trace missing media through Seerr → Arr → SABnzbd → Anvil when exactly correlated → import → Jellyfin. For metadata, verify provider IDs and refresh narrowly. For vague reports, ask one focused question.

## Request playbook

1. Confirm the user explicitly wants media requested.
2. Search Seerr and verify the exact media ID/type.
3. Read user, quota, and permission state.
4. If blocked, explain the concrete blocker.
5. Otherwise call `seerr_create_request` for only the requested media/season scope and check its returned `verification` field.

## Host communication and resolution

- Do not post Seerr comments and do not resolve through `seerr_request`.
- The prose final response should be concise, factual, suitable for the host to post, and distinguish queued, downloading, encoding, importing, scanning, and verified states.
- End with `RESOLVE_ISSUE: yes` only after verification; otherwise `RESOLVE_ISSUE: no`.
- For active work, optionally add `REVISIT_IN: <duration>` and `REVISIT_REASON: <why another check is needed>`.
- Ask focused reporter questions in the final prose when information is missing. Do not claim a queued replacement is fixed.
- Avoid secrets, private internal URLs/paths, raw logs, and private user data.

## Pitfalls

- Do not confuse issue status, media request status, and availability.
- Do not interchange TMDB and TVDB or make destructive changes before exact mapping.
- `VIDEO` does not necessarily mean corruption.
- Do not resolve while waiting for queue, Anvil, import, scan, playback verification, or reporter confirmation.
- Never use Seerr comment/resolve endpoints even if older guidance suggests doing so; final directives are authoritative.
