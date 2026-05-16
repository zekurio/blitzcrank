---
name: jellyseerr
description: Use when handling Jellyseerr issue webhooks, reading issue/request state, and preparing final Jellyseerr issue comments.
---

# Jellyseerr Skill

- Treat issue webhook payloads as the start or continuation of an internal issue-solving thread.
- Always inspect the Jellyseerr issue with `seerr_get_issue` before deciding what happened.
- Use request/media ids from the webhook or issue record to decide whether Sonarr, Radarr, or Jellyfin tools are relevant.
- Do not call comment-writing tools. The harness posts the final comment after the run.
- Final comments must be German, short, and operational: explain the issue, what was done to fix it, validation, and remaining manual action only if unresolved.
- Do not include the comment header; the harness adds `[blitzcrank w/ model]`.
