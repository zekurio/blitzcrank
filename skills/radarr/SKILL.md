---
name: radarr
description: Diagnose and safely remediate Radarr-managed movies, releases, queues, imports, files, and quality upgrades. Load for Seerr movie issues involving missing, corrupt, wrong, stalled, or repeatedly replaced media.
---

# Radarr

Use the read-only `radarr_request` with relative `/api/v3/...` paths; it accepts only `purpose` and `path` and performs GETs. All state changes use the dedicated typed Radarr tools below. Each mutation requires a `reason`, and every target ID must first appear in a Radarr read during the current run. The tool layer enforces a maximum of 5 mutations and 2 deletions per run.

## Terminology

- **Movie**: Radarr record with internal `id`, title, year, path, monitoring, minimum availability, and profile.
- **tmdbId**: Primary external movie identity from Seerr; never substitute it for Radarr's internal ID.
- **Movie file**: Imported file with path, size, parsed quality, release metadata, and often `mediaInfo`.
- **`languages` on releases, queue items, history, and files**: Parsed from the release _name_, not from the file. `MULTi`, `DL`, and `GERMAN` are claims by the release group; only `media_probe` (or Jellyfin streams after import) proves what a file contains.
- **Quality profile/custom formats**: Acceptance, scoring, upgrade, language, edition, and cutoff rules.
- **Queue/history/blocklist**: Current tracked downloads, past events, and releases excluded from selection.
- **Download ID**: Correlates Radarr to SABnzbd; it is distinct from movie, file, and queue IDs.
- **Command**: Asynchronous search or refresh; completion alone does not prove import.

## How it fits the stack

1. Seerr supplies the movie `tmdbId` and report context.
2. Radarr selects a release and sends it to SABnzbd.
3. SABnzbd downloads and post-processes; Anvil may encode before import.
4. Radarr imports into its managed movie path, and Jellyfin scans and serves it.
5. Diagnose acquisition, downloader, Anvil, import, metadata, and playback boundaries separately.

## Common reads

- TMDB lookup: `GET /api/v3/movie?tmdbId={tmdbId}`
- Title/TMDB lookup: `GET /api/v3/movie/lookup?term={query}`
- Movie: `GET /api/v3/movie/{movieId}`
- Calendar: `GET /api/v3/calendar?start={urlEncodedISODate}&end={urlEncodedISODate}`
- Movie file: `GET /api/v3/moviefile/{movieFileId}` or `GET /api/v3/moviefile?movieId={movieId}`
- History: `GET /api/v3/history?movieId={movieId}&page=1&pageSize=20&sortKey=date&sortDirection=descending`
- Queue: `GET /api/v3/queue?page=1&pageSize=50&includeUnknownMovieItems=true`
- Blocklist: `GET /api/v3/blocklist?page=1&pageSize=50&movieId={movieId}`
- Profiles: `GET /api/v3/qualityprofile`
- Manual import: `GET /api/v3/manualimport?folder={urlEncodedFolder}&downloadId={urlEncodedDownloadId}`
- System: `GET /api/v3/system/status`
- Anvil: `anvil_status` for health and `anvil_job_lookup` for exact correlation when configured.
- File contents: `media_probe` on `movieFile.path` or on a queue `outputPath` when configured; load the `media-probe` skill for language questions.

## Diagnostic workflow

1. Fetch the live Seerr issue and map `tmdbId` to Radarr. TMDB identity overrides IMDb or other enrichment; do not construct unverified links.
2. Record year, path, monitoring, minimum availability, profile, internal ID, and file state.
3. Inspect file release title, quality, size, custom formats, edition/language data, and `mediaInfo`.
4. Inspect queue, reverse-chronological history, blocklist, and profiles. Correlate download IDs with read-only `sabnzbd_request`.
5. For release dates, prefer Radarr movie/calendar data and name the date type: cinema (`inCinemas`), digital, or physical; state uncertainty.
6. For audio, subtitle, codec, or playback reports, inspect the actual file with `media_probe` (it also works on completed, not-yet-imported downloads) and the imported streams with `jellyfin_request`, then use Radarr evidence to explain selection/import. Radarr `languages` is release-name parsing and never settles whether a track exists.
7. Exhaust local queue/history/blocklist/file/profile and narrow search evidence before external availability reasoning.
8. Treat completion as pending Anvil only when `anvil_job_lookup` exactly matches an absolute Radarr `outputPath`, or exact SAB `storage` linked by `downloadId`/`nzo_id`, to active current jobs and Radarr has file-not-ready evidence. Health alone is never item evidence.
9. Apply the smallest targeted action. Check the mutation result's `verification` field, use follow-up reads when needed to confirm queue/blocklist/movie/file state, and verify Jellyfin afterward.

## Allowed typed mutations

Every call below requires a `reason`. Fetch the target IDs with `radarr_request` first, and inspect the returned `verification` field.

- Search one movie: call `radarr_search` with the verified `movieId`.
- Refresh one movie: call `radarr_refresh_movie` with the verified `movieId`.
- Retry a known queue item: call `radarr_grab_queue_item` with the verified `queueId`.
- Remove a verified bad queue item: call `radarr_delete_queue_item` with the verified `queueId` and explicit `blocklist` and `removeFromClient` booleans. This consumes the deletion budget.
- Remove only a clearly matching blocklist entry: call `radarr_remove_from_blocklist` with the verified `blocklistId`.
- Delete one verified corrupt or otherwise unusable movie file: call `radarr_delete_movie_file` with the verified `movieFileId`. This consumes the deletion budget and removes the only copy of the movie from disk. The `movieFileId` must come from a Radarr read this run, such as `GET /api/v3/moviefile?movieId={movieId}`; the tool re-reads the movie file and verification must confirm HTTP 404.
- Manually import verified candidates: call `radarr_manual_import` with `importMode: "auto"` and candidate objects returned by `GET /api/v3/manualimport?folder={folder}&downloadId={downloadId}`, trimmed to `path`, `folderName`, `movieId`, `quality`, `languages`, `releaseGroup`, and `indexerFlags` when present. Every file path and ID submitted must have appeared in a Radarr read this run. The tool consumes the mutation budget and verifies the resulting command status.

No generic force-import tool is exposed. Do not remove, blocklist, retry, search, refresh, manually import, or delete a movie file during an exact active Anvil wait.

## Playbooks

### Missing movie or missing after grab

Check monitoring, minimum availability, file record, queue, history, SAB state, and exact Anvil correlation. Do not duplicate a progressing job. For sound completed payloads, diagnose import access/category/naming first. Search once only when missing, after a failed release is cleared, or when explicitly asked for replacement/fix.

### Missing audio or subtitle track

Probe the file before anything else: `media_probe` on the movie file, or on the queue `outputPath`/SAB `storage` when the download has not imported yet. If the track is not in the file, report that; re-grabbing the same release cannot add a track that was never there. Only search when a genuinely different release is plausible, say so explicitly, and never search or delete on `languages` metadata alone. If the track is in the file but not offered in playback, the problem is Jellyfin/client side. See the `media-probe` skill.

### Corrupt, unplayable, wrong movie, cut, or language

Verify the report with strong evidence, such as the user report plus a `media_probe` result, Jellyfin stream, or Radarr `mediaInfo` anomalies; never delete on a vague report. Resolve the `tmdbId` with `GET /api/v3/movie?tmdbId={tmdbId}`, fetch the file with `GET /api/v3/moviefile?movieId={movieId}`, and confirm that exact file is the problematic item, including multi-version selection and the originating release. Because deletion removes the only copy of the movie, call `radarr_delete_movie_file` only when the evidence is strong, check that its `verification` reports HTTP 404, then call `radarr_search` for the verified movie. Verify the replacement appears in the queue, schedule a revisit for download/import/playback validation, and after replacement verify edition, audio, and playback. Identify and report any profile/custom-format cause.

### Stuck queue or failed import

Read the Radarr warning and correlate SAB by download ID. Allow genuine download, verification, repair, unpack, and exact Anvil work. Use service evidence for path mapping, permissions, space, locks, category, and recognized-video failures. Correct environmental causes before retrying; re-search only if the payload is bad.

### Manual import of a completed download

Manual import is appropriate when a completed download remains unimported in the queue and import is blocked, delayed, failed, or has an unknown status. Typical causes include a worse-scored release finishing after a better-scored release was grabbed, or import warnings that have gone stale.

1. Read the queue and identify the exact queued movie, folder, and `downloadId`.
2. Read `GET /api/v3/manualimport?folder={urlEncodedFolder}&downloadId={urlEncodedDownloadId}` with `radarr_request`.
3. Inspect `rejections` on every candidate, including candidates that otherwise look safe.
4. Import only candidates resolved to the exact queued movie whose path and `downloadId` belong to that queued download, with acceptable quality and language evidence. Pass only the documented trimmed fields and use `importMode: "auto"`.
5. Re-read the queue and confirm the item cleared; also verify the resulting movie-file state as appropriate.

Do not import candidates with substantive rejections, including wrong target, sample, missing path, permissions, duplicate conflict, unwanted language, or low score/profile cutoff. Never import while a transcode or Anvil job owns the path. When rejection evidence instead warrants cleanup, use `radarr_delete_queue_item` with `blocklist: true` rather than forcing the import.

### Upgrade loop

Inspect repeated grabs/imports/deletions, parsed quality, custom-format score, cutoff, language, edition, and naming. Correct the profile or parsing cause, then run one search and verify the final file.

### File exists but Radarr says missing

Confirm path/layout evidence available through APIs, runtime visibility, and naming. Refresh the movie and inspect import/rejection results. Do not create a duplicate before evaluating the existing file.

## Verification and communication

- A grab is not a download; SAB completion is not import; a Radarr file record is not Jellyfin playback proof.
- Call `report_progress` as the first action, with one short public, user-facing status sentence; do not include internal tool names, IDs, URLs, or promises. It is one live status line: later calls rewrite it in place and your final comment replaces it.
- Do not call Seerr comment or resolve endpoints. Final output must include `RESOLVE_ISSUE: yes|no`; unresolved work may include `REVISIT_IN` and `REVISIT_REASON`.
- Resolve only after physical/file-state evidence available through services and the original Jellyfin symptom are verified.

## Pitfalls

- Keep TMDB, movie, movie-file, queue, and SAB IDs distinct.
- Delete movie files only through `radarr_delete_movie_file`, with strong item-specific evidence; never delete directly from disk or repeatedly trigger searches.
- Respect monitoring and minimum availability.
- Check Jellyfin multi-version selection and metadata before replacing valid media.
- Do not infer Anvil work from a guessed path, title match, or daemon health.
- Do not treat `languages` on a release, queue item, or file as proof that an audio or subtitle track exists.
- Never resolve while only a queue or encoding job exists.
