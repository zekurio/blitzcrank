---
name: filesystem
description: Archived filesystem guidance for media import diagnostics; no filesystem tool is currently exposed to Pi.
---

# Filesystem Skill

No filesystem request tool is currently exposed to Pi. Do not claim direct filesystem checks, disk usage checks, permission checks, file moves, deletes, chmod/chown, or path edits.

When Sonarr/Radarr/SABnzbd evidence points to filesystem-like causes, such as missing completed files, path mapping problems, permission failures, or disk space issues, report only what the service APIs actually say. Use Sonarr/Radarr queue, manual import, and history evidence; use SABnzbd queue/history evidence for downloader-side state.

If filesystem evidence is required but unavailable through the service APIs, state that the available service checks could not verify the filesystem blocker. Do not invent file paths, ownership, free space, or repair actions.
