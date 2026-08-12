---
name: filesystem
description: Archived filesystem guidance for media import diagnostics; the only filesystem access is the read-only media_probe tool.
---

# Filesystem

The only filesystem access is read-only `media_probe`: ffprobe on one file (or
the largest media file in a release directory) within configured media roots.
See the `media-probe` skill. There is no list, stat, arbitrary read/write, move,
delete, permission, ownership, or disk-usage tool. Never claim those checks or
repairs. Raw service request tools are GET-only; supported mutations require a
dedicated typed tool, `reason`, prior ID evidence, and inspection of returned
`verification`.

For missing files, mappings, permissions, or space, report only Sonarr/Radarr
queue/manual-import/history and SABnzbd queue/history API evidence.

If APIs or a probe cannot verify a filesystem blocker, state that limitation.
Never invent paths, ownership, free space, or repair steps.
