---
name: hourly-stale-import-handler
description: Hourly Sonarr/Radarr handler for stale completed downloads that are safe to manually import, force import, or clean up after clear import rejection.
schedule: "@hourly"
---

Run the hourly stale import handler.

Use `sandbox_run_typescript` to inspect Sonarr and Radarr queues first. The target is queue/activity entries where the download is complete but Sonarr or Radarr did not import automatically, usually because the release filename or folder name confused automatic matching, because an otherwise valid manual import candidate is blocked by the queue import blocker, or because Sonarr/Radarr clearly rejected the candidate and the stale download should be cleaned from both Arr and the download client.

Before acting on any queue item, review durable memory and the prior automation history included above the current prompt. Use `memory_list` or `memory_search` first for scope `automation` and key prefix `hourly-stale-import-handler/`. The injected history is still useful recent context, but durable Markdown memories are the preferred source for long-lived manual-intervention state.

Build a do-not-touch set from open manual-intervention memories and from any prior `MANUAL_INTERVENTION_REQUIRED` history lines that have not yet been migrated into memory. Match by service plus the most specific stable identifiers available: download id, queue id, release/folder/file path, title, season/episode, movie year, and candidate target.

Do not import, force import, retry, search, delete, or otherwise mutate an item that prior history already marked `MANUAL_INTERVENTION_REQUIRED`, unless current Sonarr/Radarr evidence clearly shows it is a different download, that the exact blocker was resolved by a human since the prior run, or that the stable identifiers match and the current rejection is clear enough for this automation to cleanly remove the stale download. If the same blocked item is still visible and does not qualify for rejection-based cleanup, leave it untouched silently and do not re-report it in the final response.

If prior history says an import was accepted but validation still showed the same queue/import blocker, treat that item as unresolved. Check the current queue and manual import candidate again through `sandbox_run_typescript`. If the candidate is still clearly the correct movie or episode and the only blocker is the stale queue/import warning, run the matching manual import API call with `force` set to `true`; otherwise mark it `MANUAL_INTERVENTION_REQUIRED` instead of reporting the same accepted-but-not-validated import as success again.

Context compaction flow:

1. First read durable automation memories for `hourly-stale-import-handler/`, then read the persistent manual-intervention ledger from injected history for older records.
2. Reconstruct the active blocked set from memory before inspecting current queue entries.
3. For each current queue entry, classify it as one of: prior manual item, newly safe import candidate, rejection-cleanup candidate, newly unsafe/manual item, not relevant to stale completed imports, or sandbox/error state.
4. Prior manual items are memory only. Confirm identity only as much as needed to avoid touching them, then skip them unless current evidence proves they are rejection-cleanup candidates.
5. Newly unsafe/manual items must be written with `memory_upsert` under scope `automation` with a key like `hourly-stale-import-handler/manual-intervention/<service>-<title-or-download-id>`. Include enough stable identifiers in metadata that future compacted runs can recognize them without the older full transcript.
6. If a previously blocked item is no longer present or tool evidence shows a human resolved it, update the memory content or delete the obsolete memory.
7. If memory and history have missing details, prefer conservative matching: never mutate a queue item that plausibly matches a prior manual marker.

For each stale completed item:

1. Inspect the matching manual import candidates by calling the Sonarr or Radarr manual import API from `sandbox_run_typescript`.
2. Always inspect the candidate `rejections` before deciding, even when the rest of the candidate looks safe. Treat explicit Sonarr/Radarr rejections as first-class evidence; the model should decide whether to force import, remove the download cleanly, or escalate, with the goal of keeping manual intervention low and the queue clean.
3. Import only candidates that are clearly safe:
   - the candidate matches the queued series episode or movie
   - the file path belongs to the queued download
   - quality and language look correct for the request
   - custom format score is high or otherwise clearly acceptable from the candidate data
   - there is no evidence of path, permissions, missing-file, sample, duplicate, or existing-file conflict
4. Use the matching Sonarr or Radarr manual import API only for safe candidates. For Sonarr, set import mode to `Move`; for Radarr, leave import mode empty or set it to `auto`.
   - If `rejections` is empty or absent, import normally.
   - If the only rejection is the stale import blocker or a queue/import warning and the candidate is otherwise clearly correct, use the import tool with `force` set to `true`.
   - Never force or allow an import when Sonarr/Radarr gives a clear substantive rejection. If importing this candidate would bypass a quality/profile/score/language/duplicate/existing-file/sample/wrong-target decision, treat it as a rejection-cleanup candidate instead of a manual-review item.
   - Treat name/ID ambiguity as unsafe unless the service already resolved the candidate to the exact queued episode/movie and the rest of the evidence still matches. This is especially important for Radarr cases where filename parsing alone is weak.
   - For movies, a high custom format score, matching Radarr `movieId`, matching release/folder path, matching languages, and matching quality are enough to force past a stale queue/import warning; do not require extra manual confirmation solely because the title year or localized alternate title differs when Radarr already resolved the candidate to the queued movie.
   - For Radarr, do not use `Move`; empty or `auto` sends the same `ManualImport` command shape as the Radarr web UI.
   - Do not force import sample files, missing paths, permission failures, existing-file conflicts, duplicates, lower-scored releases, or any candidate whose target episode/movie is uncertain.
5. For a rejection-cleanup candidate, remove it when all of these are true:
   - Sonarr/Radarr resolved the manual import candidate to the exact queued episode or movie
   - the file path or download id belongs to the queued completed download
   - the explicit rejection or candidate data makes the download clearly not useful to import, including but not limited to lower custom-format/quality/release score, profile cutoff, unwanted language, duplicate or existing file, sample, wrong episode/movie target, blocked target, missing file, permissions failure, or any other clear Sonarr/Radarr rejection
   - there is no unresolved ambiguity about which queue item and download-client job will be removed
6. For rejection-cleanup candidates, use `sandbox_run_typescript` to call the matching Sonarr or Radarr queue removal API with the queue id, `removeFromClient=true`, and `blocklist=true`. This removes the stale item from Sonarr/Radarr and asks Sonarr/Radarr to remove the matching job from the download client; do not use direct filesystem deletion.
7. Validate by reading the Sonarr/Radarr queue again and confirm the item disappeared or no longer reports the stale import blocker/rejection after import/removal.

Use SABnzbd queue/history only when a Sonarr/Radarr queue item needs confirmation that the download actually completed or failed. Use filesystem checks only when the queue or candidate data points to a path, permissions, missing-file, or disk-space problem.

Do not trigger searches, retry unrelated queue items, refresh libraries, delete files directly, clear blocklists, or resolve Seerr issues from this automation. The only cleanup deletion allowed is the rejection-based queue removal described above. Do not import uncertain matches. For Sonarr, be especially strict: if the queued episode and the manual import candidate episodes disagree, do not import it; remove it only when the service evidence clearly shows this is a wrong-episode download tied to the queued completed item, otherwise report it for manual review.

Return a German operations note focused on the actual outcome from this run. It should read like a short handover for an operator, not like a dump of internal fields. Be concise for successful imports. For newly discovered manual-review items, write the human-readable reason in the report and persist stable identifiers with `memory_upsert` instead of putting them in the Discord-visible message.

Only mention downloads in `Importiert:` that were actually imported and then validated as resolved in this run. Do not list attempted imports, accepted-but-not-validated imports, old successes from prior history, or items merely inspected.

Only mention downloads in `Entfernt:` that were actually removed through the Sonarr/Radarr queue removal API and then validated as resolved in this run because Sonarr/Radarr gave a clear rejection and the download would not be imported.

Only use `Importiert:` for items that satisfy both conditions in this run:
- the automation actually triggered the import
- the post-import validation showed the queue item disappeared or the stale import blocker was gone

Use `Manuell prüfen:` only for items that were inspected in this run and intentionally not imported because automation judged them unsafe. Do not include unchanged prior-history manual items in this section.

Suppress empty sections completely. Do not emit headings with placeholder text, half-formulated text, or empty bullets. If a section would contain no concrete item from this run, omit that section.

Use exactly one of these message shapes:

1. If one or more imports or rejection-based removals were handled, list the handled items:
   - `Importiert:` with one bullet per imported item. Include service, title, season/episode or movie year when available, and the imported file or release name.
   - Write each `Importiert:` bullet as a complete sentence that already includes the validation outcome inline, for example that the queue item disappeared after import. Do not emit a separate `Validierung:` section.
   - `Entfernt:` with one bullet per rejected download that was removed from Sonarr/Radarr and the download client. Include service, title, season/episode or movie year when available, release/folder name when useful, and the plain-language rejection reason. Each bullet must include the validation outcome inline.
   - `Manuell prüfen:` only include this section when new stale items from this run were intentionally skipped because the match was unsafe or uncertain. Do not use `Manuell prüfen:` for confirmed rejection-cleanup candidates that were removed successfully.
   - In `Manuell prüfen:`, each item is one human-readable German bullet that starts with the service and title, then explains the practical blocker in plain language. Mention wrong-episode downloads explicitly when Sonarr candidates do not match the queued episode. Do not lead with queue ids, download ids, enum names, or tool rejection names.
   - Before reporting a new manual-review item, persist it with `memory_upsert`. The memory content should summarize the blocker; metadata should include service, title, season/episode or movie year, queue/download id when available, release or folder name, file path when available, candidate target, exact rejection/blocker, and the reason it is unsafe to automate.
   - Do not include old prior-history manual-intervention items in `Manuell prüfen:` when there are new imports or new skipped items to report.
2. If no new stale imports, rejection-based removals, or newly blocked downloads were found, do not post a message, even if prior manual-intervention items are still present unchanged in the queue.
3. If no imports were safe but one or more stale items were inspected and require manual review, post only `Manuell prüfen:` with the item shape described above.
4. If the queue or import sandbox checks failed, say that errors occurred and list the affected service plus the practical next step, for example checking Sonarr/Radarr availability. Do not claim that imports, validation, or queue checks happened when they could not be completed.

For example, prefer this shape for a clear rejected cleanup:

Entfernt:
- Sonarr: Digimon Beatbreak S01E31 wurde entfernt, weil Sonarr den manuellen Kandidaten eindeutig als falsche Folge S01E21 abgelehnt hat; nach der Queue-Entfernung mit Download-Client-Cleanup war der Eintrag verschwunden.

For example, prefer this shape only when the evidence is still ambiguous:

Manuell prüfen:
- Sonarr: Digimon Beatbreak S01E31 wurde nicht importiert oder entfernt, weil der Queue-Eintrag und der manuelle Kandidat nicht sicher demselben Download zugeordnet werden konnten.

Do not use generic sections such as `Auffälligkeiten`, `Aktionen`, `Validierung`, and `Manuelle Schritte` unless they contain concrete imported items or concrete errors from this run.
