---
name: hourly-stale-import-handler
description: Hourly Sonarr/Radarr handler for stale completed downloads that are safe to manually import.
schedule: "@hourly"
---

Run the hourly stale import handler.

Use Sonarr and Radarr queue tools first. The target is queue/activity entries where the download is complete but Sonarr or Radarr did not import automatically, usually because the release filename or folder name confused automatic matching.

For each stale completed item:

1. Inspect the matching manual import candidates with the Sonarr or Radarr manual import candidate tool.
2. Import only candidates that are clearly safe:
   - the candidate matches the queued series episode or movie
   - the file path belongs to the queued download
   - quality and language look correct for the request
   - custom format score is high or otherwise clearly acceptable from the candidate data
   - `rejections` is empty or absent
   - there is no evidence of path, permissions, missing-file, sample, duplicate, or existing-file conflict
3. Use the matching Sonarr or Radarr manual import tool with `import_mode` set to `Move` only for safe candidates.
4. Validate by reading the Sonarr/Radarr queue again and confirm the item disappeared or no longer reports the stale import blocker.

Use SABnzbd queue/history only when a Sonarr/Radarr queue item needs confirmation that the download actually completed or failed. Use filesystem checks only when the queue or candidate data points to a path, permissions, missing-file, or disk-space problem.

Do not trigger searches, retry unrelated queue items, refresh libraries, delete files, clear blocklists, or resolve Jellyseerr issues from this automation. Do not import candidates with explicit rejections or uncertain matches; report those for manual review.

Return a concise German operations summary focused on the actual outcome.

Use exactly one of these message shapes:

1. If one or more imports were handled, list the handled imports and validation result:
   - `Importiert:` with one bullet per imported item. Include service, title, season/episode or movie year when available, and the imported file or release name.
   - `Validierung:` state whether the item disappeared from the queue or no longer reports the import blocker.
   - `Manuell prüfen:` only include this section when some stale items were intentionally skipped because the match was unsafe or uncertain.
2. If no stale imports or blocked downloads were found, do not post a message.
3. If the queue or import tools failed, say that errors occurred and list the affected service/tool plus the practical next step, for example checking Sonarr/Radarr availability. Do not claim that imports, validation, or queue checks happened when they could not be completed.

Do not use generic sections such as `Auffälligkeiten`, `Aktionen`, `Validierung`, and `Manuelle Schritte` unless they contain concrete imported items or concrete errors from this run.
