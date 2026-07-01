---
name: sabnzbd
description: Use when diagnosing SABnzbd queue, history, failed downloads, stuck jobs, or Sonarr/Radarr download handoff issues.
---

# SABnzbd Skill

Use `sabnzbd_request` with relative `/api?mode=...` paths. Blitzcrank injects `apikey` and `output=json`; never include credentials in the path. Every request needs `purpose`. SABnzbd requests are currently read-only.

## Common reads

- Queue: `GET /api?mode=queue`
- History: `GET /api?mode=history&limit=20`
- Anvil status: use `anvil_status` when SABnzbd is complete but Sonarr/Radarr import is waiting on file-not-ready evidence.
- Full queue/history only when needed; prefer narrow limits.

## Diagnostic rules

- Check Sonarr or Radarr queue first when the issue came from a media request, then inspect SABnzbd queue/history for the matching title, release, nzb name, or download id.
- A completed SABnzbd history item does not guarantee Sonarr/Radarr can import immediately. Anvil may still be encoding the files between SABnzbd completion and Arr import.
- Use SABnzbd evidence to explain active downloads, failed downloads, missing completed jobs, paused queue state, or downloader-side failures.
- Do not claim a retry, deletion, or repair was performed from SABnzbd evidence alone.
- If queue/history points to missing completed files, disk space, permissions, or path mapping, report the concrete blocker from the available service evidence; filesystem mutation tools are not available.
