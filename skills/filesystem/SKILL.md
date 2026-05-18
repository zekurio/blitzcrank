---
name: filesystem
description: Use when diagnosing disk space, file presence, permissions, timestamps, path mapping, or filesystem visibility under allowed roots.
---

# Filesystem Skill

- Use `sandbox_run_typescript` for filesystem-adjacent diagnosis only when the sandbox reviewer grants the needed read-only access.
- Check disk usage before assuming an application bug.
- Check whether completed files exist where Sonarr/Radarr expects them.
- Check file modes, ownership implications, and timestamps when files exist but imports fail.
- Do not delete, move, chmod, chown, rename, overwrite, or edit files; no filesystem repair tools are available in this skill.
- If filesystem evidence points back to a failed or stuck download, use the SABnzbd skill when it is available.
- Final comments follow the system language rules and explain the concrete filesystem blocker in user-friendly language.
