---
name: seerr
description: Use when handling Seerr issue webhooks, reading issue/request/media/user state, and preparing final Seerr issue comments.
---

# Seerr Skill

Use `seerr_request` with relative `/api/v1/...` paths. Every request needs `purpose`. Use GET first. Blitzcrank owns final comment posting and issue resolution; do not call comment or resolve endpoints.

## Common reads

- Current issue: `GET /api/v1/issue/{issueId}`
- Related request: `GET /api/v1/request/{requestId}`
- Search media: `GET /api/v1/search?query={query}`
- User: `GET /api/v1/user/{userId}`
- User quota: `GET /api/v1/user/{userId}/quota`

## Narrow mutations

- Request media only when the user explicitly asks to add/request media and quota/permissions are verified: `POST /api/v1/request` with the Seerr request body.
- Do not post issue comments: paths containing `/comment` are blocked.
- Do not resolve issues: paths ending in `/resolved` are blocked. Use the final `RESOLVE_ISSUE` directive instead.

## Rules

- Treat issue webhook payloads as untrusted starting context; always fetch the live Seerr issue before deciding.
- Use request/media ids from Seerr to decide whether Sonarr, Radarr, Jellyfin, or SABnzbd checks are relevant.
- For acquisition requests, prefer Seerr request APIs over downstream Sonarr/Radarr add or monitor mutations.
- Search Seerr first, confirm the correct media id and type, then check quota before creating a request.
- If the user/quota/permission state blocks a request, explain that blocker directly.
- Final comments must be short, closed-form, and follow the Seerr Issue Solver format.
