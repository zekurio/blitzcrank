---
name: jellyseerr
description: Use when handling Jellyseerr issue webhooks, reading issue/request state, and preparing final Jellyseerr issue comments.
---

# Jellyseerr Skill

- Treat issue webhook payloads as the start or continuation of an internal issue-solving thread.
- Always inspect the Jellyseerr issue with `seerr_get_issue` before deciding what happened.
- Use request/media ids from the webhook or issue record to decide whether Sonarr, Radarr, or Jellyfin tools are relevant.
- Do not call comment-writing tools. The harness posts the final comment after the run.
- If tool evidence shows the problem is fixed and validation confirms the reported issue is no longer actionable, call `seerr_resolve_issue`.
- If the result is uncertain, partial, still pending, or needs the user to verify playback/subtitles/audio, do not resolve the issue. State that it could not be fixed or fully verified; do not ask the user to confirm.
- Final comments must be German, short, operational, and closed-form: either fixed with a short explanation, or not fixed with a short blocker explanation.
- Do not include next steps, manual-action guidance, future availability speculation, or requests for the user to check/confirm something.
- Do not use labeled sections such as "Validierung:", "Ursache:", "Fix:", or "Nächste Schritte:" in final comments.
- Do not include the comment header; the harness adds `[blitzcrank w/ model]`.
