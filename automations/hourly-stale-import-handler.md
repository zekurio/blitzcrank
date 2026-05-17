---
name: hourly-stale-import-handler
description: Hourly Sonarr/Radarr handler for stale completed downloads that are safe to manually or force import.
schedule: "@hourly"
---

Run the hourly stale import handler.

Use Sonarr and Radarr queue tools first. The target is queue/activity entries where the download is complete but Sonarr or Radarr did not import automatically, usually because the release filename or folder name confused automatic matching or because an otherwise valid manual import candidate is blocked by the queue import blocker.

Before acting on any queue item, review the prior automation history included above the current prompt. This history is read from the local automation thread trace under `threads/automations/` and may include both a recent transcript and a persistent manual-intervention ledger that survives context compaction. Treat the ledger as authoritative operational memory.

Build a do-not-touch set from every prior `MANUAL_INTERVENTION_REQUIRED` item, especially entries in the persistent manual-intervention ledger. Match by service plus the most specific stable identifiers available: download id, queue id, release/folder/file path, title, season/episode, movie year, and candidate target.

Do not import, force import, retry, search, delete, or otherwise mutate an item that prior history already marked `MANUAL_INTERVENTION_REQUIRED`, unless current Sonarr/Radarr evidence clearly shows it is a different download or that the exact blocker was resolved by a human since the prior run. If the same blocked item is still visible, leave it untouched silently and do not re-report it in the final response.

If prior history says an import was accepted but validation still showed the same queue/import blocker, treat that item as unresolved. Check the current queue and manual import candidate again. If the candidate is still clearly the correct movie or episode and the only blocker is the stale queue/import warning, call the import tool with `force` set to `true`; otherwise mark it `MANUAL_INTERVENTION_REQUIRED` instead of reporting the same accepted-but-not-validated import as success again.

Context compaction flow:

1. First read the persistent manual-intervention ledger from the injected history, then read the newest recent records.
2. Reconstruct the active blocked set from the ledger before inspecting current queue entries.
3. For each current queue entry, classify it as one of: prior manual item, newly safe import candidate, newly unsafe/manual item, not relevant to stale completed imports, or tool/error state.
4. Prior manual items are memory only. Confirm identity only as much as needed to avoid touching them, then skip them.
5. Newly unsafe/manual items must be written with enough stable identifiers that future compacted runs can recognize them without the older full transcript.
6. If the history has been compacted and details are missing, prefer conservative matching: never mutate a queue item that plausibly matches a prior manual marker.

For each stale completed item:

1. Inspect the matching manual import candidates with the Sonarr or Radarr manual import candidate tool.
2. Import only candidates that are clearly safe:
   - the candidate matches the queued series episode or movie
   - the file path belongs to the queued download
   - quality and language look correct for the request
   - custom format score is high or otherwise clearly acceptable from the candidate data
   - there is no evidence of path, permissions, missing-file, sample, duplicate, or existing-file conflict
3. Use the matching Sonarr or Radarr manual import tool only for safe candidates. For Sonarr, set `import_mode` to `Move`; for Radarr, leave `import_mode` empty or set it to `auto`.
   - If `rejections` is empty or absent, import normally.
   - If the only rejection is the stale import blocker or a queue/import warning and the candidate is otherwise clearly correct, use the import tool with `force` set to `true`.
   - Never force or allow an import when the rejection indicates that Sonarr/Radarr would choose or keep a better-scored existing/importable release. If importing this candidate could replace, override, or bypass a higher-scored decision, treat it as unsafe and do not import it.
   - Treat name/ID ambiguity as unsafe unless the service already resolved the candidate to the exact queued episode/movie and the rest of the evidence still matches. This is especially important for Radarr cases where filename parsing alone is weak.
   - For movies, a high custom format score, matching Radarr `movieId`, matching release/folder path, matching languages, and matching quality are enough to force past a stale queue/import warning; do not require extra manual confirmation solely because the title year or localized alternate title differs when Radarr already resolved the candidate to the queued movie.
   - For Radarr, do not use `Move`; empty or `auto` sends the same `ManualImport` command shape as the Radarr web UI.
   - Do not force import sample files, missing paths, permission failures, existing-file conflicts, duplicates, or any candidate whose target episode/movie is uncertain.
4. Validate by reading the Sonarr/Radarr queue again and confirm the item disappeared or no longer reports the stale import blocker.

Use SABnzbd queue/history only when a Sonarr/Radarr queue item needs confirmation that the download actually completed or failed. Use filesystem checks only when the queue or candidate data points to a path, permissions, missing-file, or disk-space problem.

Do not trigger searches, retry unrelated queue items, refresh libraries, delete files, clear blocklists, or resolve Jellyseerr issues from this automation. Do not import uncertain matches. For Sonarr, be especially strict: if the queued episode and the manual import candidate episodes disagree, do not import it; report it for manual review as a wrong-episode download.

Return a German operations summary focused on the actual outcome from this run. Be concise for successful imports, but be deliberately specific for newly discovered manual-review items so future runs can recognize the same blocker from history.

Only mention downloads in `Importiert:` that were actually imported and then validated as resolved in this run. Do not list attempted imports, accepted-but-not-validated imports, old successes from prior history, or items merely inspected.

Only use `Importiert:` for items that satisfy both conditions in this run:
- the automation actually triggered the import
- the post-import validation showed the queue item disappeared or the stale import blocker was gone

Use `Nicht importiert:` only for items that were inspected in this run and intentionally not imported because automation judged them unsafe. Do not include unchanged prior-history manual items in this section.

Suppress empty sections completely. Do not emit headings with placeholder text, half-formulated text, or empty bullets. If a section would contain no concrete item from this run, omit that section.

Use exactly one of these message shapes:

1. If one or more imports were handled, list the handled imports:
   - `Importiert:` with one bullet per imported item. Include service, title, season/episode or movie year when available, and the imported file or release name.
   - Write each `Importiert:` bullet as a complete sentence that already includes the validation outcome inline, for example that the queue item disappeared after import. Do not emit a separate `Validierung:` section.
   - `Nicht importiert:` only include this section when new stale items from this run were intentionally skipped because the match was unsafe, uncertain, or would risk importing a worse-scored release.
   - In `Nicht importiert:`, every bullet must start with `MANUAL_INTERVENTION_REQUIRED` and include service, title, season/episode or movie year, queue/download id when available, release or folder name, file path when available, candidate target, exact rejection/blocker, and the reason it is unsafe to automate.
   - In `Nicht importiert:`, identify wrong-episode downloads explicitly when Sonarr candidates do not match the queued episode.
   - Do not include old prior-history manual-intervention items in `Nicht importiert:` when there are new imports or new skipped items to report.
2. If no new stale imports or newly blocked downloads were found, do not post a message, even if prior manual-intervention items are still present unchanged in the queue.
3. If no imports were safe but one or more stale items were inspected and require manual review, post only `Nicht importiert:` with the detailed `MANUAL_INTERVENTION_REQUIRED` bullets described above.
4. If the queue or import tools failed, say that errors occurred and list the affected service/tool plus the practical next step, for example checking Sonarr/Radarr availability. Do not claim that imports, validation, or queue checks happened when they could not be completed.

Do not use generic sections such as `Auffälligkeiten`, `Aktionen`, `Validierung`, `Manuell prüfen`, and `Manuelle Schritte` unless they contain concrete imported items or concrete errors from this run.
