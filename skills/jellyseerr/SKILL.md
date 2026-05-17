---
name: jellyseerr
description: Use when handling Jellyseerr issue webhooks, reading issue/request state, and preparing final Jellyseerr issue comments.
---

# Jellyseerr Skill

- Treat issue webhook payloads as the start or continuation of an internal issue-solving thread.
- Always inspect the Jellyseerr issue with `seerr_get_issue` before deciding what happened.
- Use request/media ids from the webhook or issue record to decide whether Sonarr, Radarr, or Jellyfin tools are relevant.
- For Discord acquisition requests such as "can you request/add/get this for me?", prefer Jellyseerr request tools over direct Sonarr/Radarr add or monitor actions.
- Search Jellyseerr first with `seerr_search_media`, confirm the correct media id and type, then check `seerr_get_user_quota` before `seerr_request_media`.
- If the Discord requester has no mapped Seerr user id, or the quota/permission state blocks the request, explain that blocker directly instead of mutating downstream services.
- Only request on behalf of another user when the request explicitly names that user and the runtime context provides a mapped Seerr user id for them.
- Do not call comment-writing tools. The harness posts the final comment after the run.
- If tool evidence shows the problem is fixed and validation confirms the reported issue is no longer actionable, call `seerr_resolve_issue`.
- If the result is uncertain, partial, still pending, or needs the user to verify playback/subtitles/audio, do not resolve the issue. State that it could not be fixed or fully verified; do not ask the user to confirm.
- Final comments follow the system language rules and must be short, operational, and closed-form: either fixed with a short explanation, or not fixed with a short blocker explanation.
- Final comments should usually be one sentence and never more than two short sentences.
- Do not include next steps, manual-action guidance, unverified future availability speculation, or requests for the user to check/confirm something.
- Do not mention actions that were not performed unless the user explicitly asked whether they were performed.
- Avoid boilerplate non-action disclaimers such as "es wurde nichts geändert" or "es wurde keine Änderung vorgenommen"; state the verified blocker directly.
- If the blocker is verified external availability, write it as a natural availability answer instead of saying the issue could not be repaired. Example: "Die deutsche Fassung ist laut WOW erst ab 22.5. verfügbar, bis dahin musst du dich gedulden."
- Do not use labeled sections such as "Validierung:", "Ursache:", "Fix:", or "Nächste Schritte:" in final comments.
- Do not include the comment header; the harness adds `[blitzcrank w/ model]`.
