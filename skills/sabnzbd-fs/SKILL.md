---
name: sabnzbd-fs
description: Use when diagnosing stuck downloads, failed imports, missing completed files, SABnzbd queue/history failures, disk space, permissions, or path mapping issues.
---

# SABnzbd and Filesystem Skill

- Use this skill when Sonarr/Radarr queue items are stuck, imports fail, downloads fail, completed files are missing, or path/permission problems are suspected.
- Check Sonarr or Radarr queue first when the issue came from a media request, then inspect SABnzbd queue/history for the matching title or download name.
- Use filesystem tools only for diagnosis and only inside allowed roots.
- Check disk usage before assuming an application bug.
- Check whether completed files exist where Sonarr/Radarr expects them.
- Check file modes, ownership implications, and timestamps when files exist but imports fail.
- Do not delete, move, chmod, chown, rename, or edit files; no filesystem repair tools are available in this skill.
- Validate by reading the relevant queue/history/path state again after any safe application-level retry.
- Final comments must be German and explain the concrete blocker in user-friendly language.
