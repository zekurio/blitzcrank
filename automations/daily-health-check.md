---
name: daily-health-check
description: Check media automation queues and recent failures.
schedule: "cron: 0 9 * * *"
---

Run the daily media automation health check.

Use available tools to inspect Sonarr queue/blocklist, Radarr queue/blocklist, SABnzbd queue/history, and filesystem disk usage when configured.

Do not perform mutating or destructive actions. Report confirmed blockers and the safest recommended follow-up, but do not clear blocklists, trigger searches, retry queue items, refresh libraries, or resolve issues from this automation.

Return a concise German operations summary with:

- Auffälligkeiten
- Aktionen
- Validierung
- Manuelle Schritte, falls nötig
