---
name: sabnzbd
description: Use when diagnosing SABnzbd queue, history, failed downloads, stuck jobs, or download handoff issues.
---

# SABnzbd Skill

- Use `sandbox_run_typescript` with the configured SABnzbd environment variables when Sonarr/Radarr queue items are stuck, downloads fail, completed jobs are missing from import, or a download handoff problem is suspected.
- Check Sonarr or Radarr queue first when the issue came from a media request, then inspect SABnzbd queue/history for the matching title or download name.
- Inspect the SABnzbd queue for active or stuck jobs.
- Inspect SABnzbd history for completed, failed, or recently retried jobs.
- SABnzbd sandbox checks should be read-only; do not claim a retry, deletion, or repair was performed from SABnzbd evidence alone.
- If the queue/history points to missing completed files, disk space, permissions, or path mapping, use the filesystem skill when it is available.
- Final comments follow the system language rules and explain the concrete download blocker in user-friendly language.
