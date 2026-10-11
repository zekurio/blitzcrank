---
name: seerr
description: Triage Seerr issues, map media identity, and check or create requests. Load for every Seerr webhook or issue, request, user, or quota question.
---

# Seerr issue handling

The host supplies a fresh issue read with comments. Fetch again only if
truncated or newer state is needed. Seerr establishes reporter and media
identity, not file contents. Issue status, request status, and availability
are separate states.

The host owns comments and issue status. No tool posts a comment or resolves
an issue; `finish_issue` tells the host what to publish.

## Reads

Read with `seerr_read` inside a `codemode` script.

```js
const issue = await tools.seerr_read({ resource: "issue", issueId: 214 })
const matches = await tools.seerr_read({
  resource: "search",
  query: "The Matrix",
})
return { issue, matches }
```

- Issue: `issue` with `issueId`. Comments, media identity, and reporter.
- Request: `request` with `requestId`. Status, seasons, and requester.
- Search: `search` with `query`. Each match has `mediaType`, `tmdbId` or
  `tvdbId`, title, and year.
- User: `user` with `userId`. Includes a permissions summary.
- Quota: `quota` with `userId`.
- Anything without a resource: `raw` with a GET `path` under `/api/v1`.

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

Create a request only when the user explicitly asks to request media. No Arr
action adds a series or movie, so a Seerr request is how media gets added.
Search first and verify TMDB identity, media type, existing requests, and TV
seasons. If a Seerr reporter identity exists, check that user's permissions and
quota, and pass their `userId` so the request is theirs.

Every write is two calls. In a script, call `seerr_plan` and return the plan.
Planning changes nothing. Read its `summary`, `effects`, and `warnings`, then
call the `seerr_apply` tool directly with the `planId`. Scripts cannot call it.

```js
return await tools.seerr_plan({
  action: "createRequest",
  mediaType: "tv",
  mediaId: 1399,
  seasons: [3],
})
```

- `createRequest` takes `mediaType`, `mediaId` (the TMDB ID, for TV too),
  optional `seasons`, and optional `userId`. The plan names the title, type,
  and seasons, and lists existing requests for the same media as warnings.
  Read an existing request before deciding; do not add a duplicate.
- `retryRequest` takes `requestId`. Use it for a request that failed to reach
  its Arr, after the cause is fixed.

Apply fails with `plan is stale: ...` when the request set changed since the
plan; read and plan again. It reads the request back as `verification`. A
second apply of one `planId` returns the first outcome with `replayed: true`.
Approving, declining, or deleting requests is admin work.
