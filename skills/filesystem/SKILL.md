---
name: filesystem
description: Archived filesystem guidance for media import diagnostics; the only filesystem access is the read-only media_probe tool.
---

# Filesystem Skill

The only filesystem access Pi has is `media_probe`: read-only ffprobe stream inspection of one media file (or the largest media file in a release directory) inside the configured media roots. See the `media-probe` skill. There is no listing, stat, read, write, move, delete, or permission tool. Do not claim direct filesystem checks, disk usage checks, permission checks, file moves, deletes, chmod/chown, or path edits. Service raw request tools are GET-only; any supported state change must use its dedicated typed tool with a `reason` and an ID fetched earlier in the current run.

When Sonarr/Radarr/SABnzbd evidence points to filesystem-like causes, such as missing completed files, path mapping problems, permission failures, or disk space issues, report only what the service APIs actually say. Use Sonarr/Radarr queue, manual import, and history evidence; use SABnzbd queue/history evidence for downloader-side state.

Treat missing/unavailable/locked/in-use/import-not-ready evidence as pending Anvil encoding only when `anvil_job_lookup` correlates the exact absolute Arr output or SABnzbd storage path to active current jobs. Anvil daemon health alone is not item-level filesystem evidence.

If filesystem evidence is required but unavailable through the service APIs or a probe, state that the available checks could not verify the filesystem blocker. Do not invent file paths, ownership, free space, or repair actions. Check any typed mutation's returned `verification` field rather than claiming direct filesystem confirmation.
