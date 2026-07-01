---
name: anvil
description: Use when Sonarr/Radarr import delays may be caused by the Anvil encoder between SABnzbd completion and Arr import.
---

# Anvil Skill

Use `anvil_status` to read the configured Anvil systemd unit. Every request needs `purpose`. The tool is read-only and cannot start, stop, restart, reload, or mutate services.

## Common reads

- Anvil service state: `anvil_status` with a concise purpose such as `check whether Anvil is still encoding before touching a completed Arr queue item`.

## Diagnostic rules

- Anvil sits between SABnzbd and Sonarr/Radarr. A SABnzbd job can be complete while Anvil is still encoding, so Sonarr/Radarr may temporarily report no importable file, a missing or unavailable path, a locked/in-use file, size changes, access/permission-like failures, or a waiting/delayed import state.
- If `anvil_status` returns `wait_recommended: true` and Sonarr/Radarr evidence is only file-not-ready style evidence, treat the item as an Anvil wait. Do not manual import, force import, remove, blocklist, retry, search, refresh, or call Seerr resolution/comment APIs for that state.
- If Anvil is inactive, still require Sonarr/Radarr evidence before acting. Do not delete or blocklist a download just because Anvil is inactive.
- If Anvil status is unavailable, fall back to the Arr/SAB evidence and the automation's grace-window rules. Prefer waiting over destructive cleanup when the only blocker is file-not-ready evidence.
- Report Anvil waits as pending encoder/import handoff only when the surrounding task asks for a report. Do not present them as failed downloads or completed fixes.
