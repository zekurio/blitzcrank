---
name: daily-health-check
description: Check media automation queues and recent failures.
schedule: "cron: 0 9 * * *"
---

Run the daily media automation health check.

Use available tools to inspect Sonarr queue/blocklist, Radarr queue/blocklist, SABnzbd queue/history, and filesystem disk usage when configured.

Do not perform destructive actions. Use safe corrective actions only when the issue is obvious and low-risk, such as clearing a confirmed stale blocklist item followed by a narrow search. Validate after any action.

Return a concise German operations summary with:

- Auffälligkeiten
- Aktionen
- Validierung
- Manuelle Schritte, falls nötig
