---
name: sonarr
description: Diagnose and safely remediate Sonarr-managed TV series, seasons, episodes, queues, imports, files, and quality upgrades. Load for Seerr issues involving a show or episode, especially missing, corrupt, wrong, stalled, or repeatedly replaced media.
---

# Sonarr

Use the read-only `sonarr_request` with relative `/api/v3/...` paths; it accepts only `purpose` and `path` and performs GETs. All state changes use the dedicated typed Sonarr tools below. Each mutation requires a `reason`, and every target ID must first appear in a Sonarr read during the current run. The tool layer enforces a maximum of 5 mutations and 2 deletions per run.

## Terminology

- **Series**: Sonarr's top-level TV record, with an internal numeric `id`, path, monitoring settings, series type, and quality profile.
- **tvdbId**: Primary external identity linking Seerr to Sonarr. It is not Sonarr's internal series ID.
- **Season / episode / episode file**: Monitoring controls search eligibility; the episode is Sonarr's logical record; the episode file is the imported file. One file can cover multiple episodes.
- **Quality/language profile and custom formats**: Rules controlling accepted releases and continued upgrades. Language profiles exist only on instances that support them.
- **`languages` on releases, queue items, history, and files**: Parsed from the release _name_, not from the file. `MULTi`, `DL`, and `GERMAN` are claims by the release group; only `media_probe` (or Jellyfin streams after import) proves what a file contains.
- **Queue / history / blocklist**: Current tracked downloads, past events, and releases prevented from being selected again.
- **Command**: An asynchronous search, refresh, or rescan. Command completion alone does not prove download or import.
- **Download ID**: Correlation key between Sonarr and SABnzbd; keep it distinct from series, episode, and file IDs.

## How it fits the stack

1. Seerr supplies TV identity, preferably `tvdbId`, plus affected season and episode.
2. Resolve that to Sonarr's internal series and episode IDs.
3. Sonarr selects a release and sends it to SABnzbd.
4. SABnzbd downloads and post-processes; Anvil may then encode files before Sonarr can import them.
5. Sonarr imports into its managed series path; Jellyfin scans and serves the result.
6. Diagnose each handoff instead of assuming the visible application caused the symptom.

## Common reads

- TVDB lookup: `GET /api/v3/series?tvdbId={tvdbId}`
- Title lookup: `GET /api/v3/series/lookup?term={query}`
- Series list: `GET /api/v3/series`
- Episodes: `GET /api/v3/episode?seriesId={seriesId}`
- Calendar: `GET /api/v3/calendar?start={urlEncodedISODate}&end={urlEncodedISODate}&includeSeries=true&includeEpisodeFile=true`
- Episode file: `GET /api/v3/episodefile/{episodeFileId}`
- Series files: `GET /api/v3/episodefile?seriesId={seriesId}`
- History: `GET /api/v3/history?seriesId={seriesId}&page=1&pageSize=20&sortKey=date&sortDirection=descending`
- Queue: `GET /api/v3/queue?page=1&pageSize=50&includeUnknownSeriesItems=true`
- Blocklist: `GET /api/v3/blocklist?page=1&pageSize=50&seriesId={seriesId}`
- Profiles: `GET /api/v3/qualityprofile`; if supported, `GET /api/v3/languageprofile`
- Manual-import candidates: `GET /api/v3/manualimport?folder={urlEncodedFolder}&downloadId={urlEncodedDownloadId}`
- System status: `GET /api/v3/system/status`
- Anvil: use `anvil_status` for health and `anvil_job_lookup` for exact item correlation when configured.
- File contents: `media_probe` on `episodeFile.path` or on a queue `outputPath` when configured; load the `media-probe` skill for language questions.

## Diagnostic workflow

1. Fetch the live Seerr issue and establish show identity, affected season/episode, and requested symptom. If scope is absent, request clarification through the final response; do not make broad changes.
2. Resolve `tvdbId` to the Sonarr series. TVDB identity overrides IMDb or anime-database enrichment. Never construct unverified external links.
3. Record path, monitoring, series type, profile, and internal ID. Fetch episodes and select the exact episode ID.
4. For release dates, prefer matching Sonarr episode/calendar `airDate` and `airDateUtc`; state timezone/date uncertainty.
5. Inspect episode-file data and `mediaInfo`, queue, reverse-chronological history, blocklist, profiles, and narrow release/search evidence before public-availability speculation.
6. For audio, subtitle, codec, or playback-track reports, inspect the actual file with `media_probe` (it also works on completed, not-yet-imported downloads) and the imported streams with `jellyfin_request`, then explain selection using Sonarr file/history/profile/custom-format evidence. Sonarr `languages` is release-name parsing and never settles whether a track exists.
7. Correlate any download ID with read-only `sabnzbd_request`. A SAB completion is not a Sonarr import.
8. If Sonarr reports file-not-ready after completion, check Anvil only with an exact absolute queue `outputPath`, or exact SAB `storage` path linked by `downloadId`/`nzo_id`. Daemon health alone is never item evidence.
9. Make the smallest reversible mutation. Check the mutation result's `verification` field, then use follow-up reads when needed to confirm queue/blocklist/episode/file and downstream state.
10. After import, verify the file record and Jellyfin item/streams. Communicate resolution through final-response directives, not Seerr comment/resolve calls.

## Allowed typed mutations

Every call below requires a `reason`. Fetch the target IDs with `sonarr_request` first, and inspect the returned `verification` field. There is no cap on non-destructive mutations: fix every episode the evidence covers rather than stopping at an arbitrary count.

- Episode search: call `sonarr_search` with the verified `seriesId` and the exact `episodeIds` fetched this run. A single episode is the correct way to test a hypothesis.
- Season search: call `sonarr_search` with the verified `seriesId` and `seasonNumber`.
- Whole-series search only for a whole-series issue: call `sonarr_search` with only the verified `seriesId`.
- Scope is enforced in code for every search form. A search touching more than one episode must pass `expectedEpisodeCount` equal to the number Sonarr actually reports; a wrong or missing value is rejected with the true count, which is the number you must have told the reporter. Replacing two or more episode files additionally requires that at least one of those exact files was inspected with `media_probe` during this run — release-name `languages` never satisfies it. Missing episodes (no file) are unaffected.
- Refresh one series: call `sonarr_refresh_series` with the verified `seriesId`.
- Retry a known queue item: call `sonarr_grab_queue_item` with the verified `queueId`.
- Remove a verified bad queue item: call `sonarr_delete_queue_item` with the verified `queueId` and explicit `blocklist` and `removeFromClient` booleans. With `removeFromClient: true` the downloaded data is destroyed, so it counts against the issue-wide deletion budget; with `removeFromClient: false` nothing is destroyed and it is uncapped.
- Blocklist a release that is no longer in the queue: call `sonarr_blocklist_from_history` with the verified `historyId` of its `grabbed` record, taken from a Sonarr history read. Use it instead of searching first: the release that scored highest once scores highest again, so a bare search re-grabs the bad release. Sonarr starts its own replacement search in response, so do not add an episode search afterwards. Verification returns the newest blocklist entries plus the queue; confirm the release is blocked and see what replaced it.
- Remove only a clearly matching blocklist entry: call `sonarr_remove_from_blocklist` with the verified `blocklistId`.
- Delete one verified wrong episode file only after replacement is confirmed by the reporter: call `sonarr_delete_episode_file` with the verified `episodeFileId`. This counts against the issue-wide deletion budget; preserve multi-episode relationships, then search only the affected episode.
- Manually import verified candidates: call `sonarr_manual_import` with `importMode: "move"` and candidate objects returned by `GET /api/v3/manualimport?folder={folder}&downloadId={downloadId}`, trimmed to `path`, `folderName`, `seriesId`, `episodeIds`, `quality`, `languages`, `releaseGroup`, and `indexerFlags` when present. Every file path and ID submitted must have appeared in a Sonarr read on this issue. The tool verifies the resulting command status.

No generic force-import tool is exposed.

Never remove, blocklist, retry, search, refresh, manual-import, or force-import an exact active Anvil wait.

## Playbooks

### Scope discipline for searches

One `SeasonSearch` re-downloads the whole season: 24 episodes, tens of gigabytes, and every one of them re-encoded. Treat it as a bulk action, not a probe.

1. Test the hypothesis on one episode: probe the file, or search that single episode with `episodeIds`.
2. Read the episodes to learn the real count before proposing a season-wide action, and name that count and its consequence to the reporter ("das sind 24 Downloads") before asking for approval. A bare "ja" to a question that never mentioned the scope is not approval for it.
3. Only then call `sonarr_search` with `expectedEpisodeCount` set to the true number.
4. If a probe shows the existing file already lacks the requested track, a replacement of the same release cannot add it — report that instead of searching.

### Missing audio or subtitle track

Probe the file before anything else: `media_probe` on the episode file, or on the queue `outputPath`/SAB `storage` when the download has not imported yet. If the track is not in the file, report that; a `SeasonSearch` or `EpisodeSearch` re-grabbing the same release cannot add a track that was never there, and it costs the whole season in downloads and encodes. Only search when a genuinely different release is plausible, say so explicitly, and never search on `languages` metadata alone. If the track is in the file but not offered in playback, the problem is Jellyfin/client side. See the `media-probe` skill.

### Missing episode

Check monitoring, air date, file record, queue, history, and path evidence. If a tracked job is progressing, do not duplicate it. Otherwise run one targeted episode search. If nothing is grabbed, report concrete profile, language, custom-format, age, size, or indexer rejection evidence.

### Corrupt, unplayable, wrong, or mislabeled episode

Verify content and Jellyfin streams rather than trusting the filename. Identify the originating history event and shared-file impact. Delete through Sonarr only under the allowed policy, blocklist only with confident release identity, search the episode once, and verify a different release through SAB, import, and Jellyfin.

### Stalled download or failed import

Read Sonarr's queue message and correlate SAB state. Allow active download, repair, and unpack work. For completed payloads, inspect category, mapping, permissions, space, locks, naming, and usable-video evidence from APIs. Check exact Anvil correlation before treating files as absent. Fix infrastructure before retrying; re-search only for an unusable payload.

### Manual import of a completed download

Manual import is appropriate when a completed download remains unimported in the queue and import is blocked, delayed, failed, or has an unknown status. Typical causes include a worse-scored release finishing after a better-scored release was grabbed, or import warnings that have gone stale.

1. Read the queue and identify the exact queued episode, folder, and `downloadId`.
2. Read `GET /api/v3/manualimport?folder={urlEncodedFolder}&downloadId={urlEncodedDownloadId}` with `sonarr_request`.
3. Inspect `rejections` on every candidate, including candidates that otherwise look safe.
4. Import only candidates resolved to the exact queued episode whose path and `downloadId` belong to that queued download, with acceptable quality and language evidence. Pass only the documented trimmed fields and use `importMode: "move"`.
5. Re-read the queue and confirm the item cleared; also verify the resulting episode-file state as appropriate.

Do not import candidates with substantive rejections, including wrong target, sample, missing path, permissions, duplicate conflict, unwanted language, or low score/profile cutoff. Never import while a transcode or Anvil job owns the path. When rejection evidence instead warrants cleanup, use `sonarr_delete_queue_item` with `blocklist: true` rather than forcing the import.

### Upgrade loop

Review repeated history, cutoff, upgrades, custom-format scores, language, naming, and parsed imported quality. Correct the rule or parsing cause instead of accumulating blocklist entries, then search once and verify cutoff satisfaction.

## Verification and communication

- Search completion is not a grab; a grab is not a download; SAB completion is not import; a Sonarr file record is not Jellyfin playback proof.
- Call `report_progress` as the first action, with one short public, user-facing status sentence; do not include internal tool names, IDs, URLs, or promises. It is one live status line: later calls rewrite it in place and your final comment replaces it.
- The host owns Seerr comments and issue resolution. In the final response, include `RESOLVE_ISSUE: yes|no`; when unresolved, optionally include `REVISIT_IN` and `REVISIT_REASON`.
- Resolve only after the reported symptom is objectively verified, or reporter confirmation is required and obtained.

## Pitfalls

- Never confuse TVDB, series, episode, episode-file, queue, and download IDs.
- Do not delete files directly from disk or trigger broad searches for a narrow issue.
- Do not assume unaired or unmonitored episodes should be searched.
- Do not blocklist without reliable history identity.
- Do not infer an Anvil wait from daemon health, a guessed path, or a title match.
- Do not treat `languages` on a release, queue item, or file as proof that an audio or subtitle track exists.
- Do not resolve merely because a replacement entered the queue.
