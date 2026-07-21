---
name: anvil
description: Use when Sonarr/Radarr import delays may be caused by the Anvil encoder between SABnzbd completion and Arr import.
---

# Anvil Skill

Use `anvil_status` for daemon health and `anvil_job_lookup` for exact item correlation. Both tools are read-only and require `purpose`. Daemon health never proves that a particular media item is encoding.

## Common reads

- Daemon health: `anvil_status` with a concise purpose such as `check whether the Anvil control API is healthy`.
- Exact item lookup: `anvil_job_lookup` with the exact absolute Sonarr/Radarr queue `outputPath`, or the SABnzbd `storage` path found by matching Arr `downloadId` to SABnzbd `nzo_id`.

## Diagnostic rules

- Anvil sits between SABnzbd and Sonarr/Radarr. A SABnzbd job can be complete while Anvil is still encoding, so Sonarr/Radarr may temporarily report no importable file, a missing or unavailable path, a locked/in-use file, size changes, access/permission-like failures, or a waiting/delayed import state.
- Never construct or guess a path from a title, release name, or basename. If no exact path is available, skip Anvil correlation and rely on Arr/SAB evidence.
- Zero matches mean the item is not an Anvil wait. A unique active current job is correlated. Multiple jobs count as one package only when every job shares the same library, source path, and source generation; otherwise the result is ambiguous. Never decide from a truncated result.
- Pending, leased, running, validating, replacing, and retrying are active states. Treat complete as requiring continued Arr/Jellyfin validation. Treat failed or skipped as concrete Anvil blockers. Compare leases and heartbeats to `server_time`; an expired lease is potentially stuck, not healthy waiting.
- Only exact active job evidence plus file-not-ready Arr evidence establishes an Anvil wait. For that state, do not manual import, force import, remove, blocklist, retry, search, refresh, or call Seerr resolution/comment APIs.
- `anvil_status` may explain control-plane unavailability, but its daemon or queue counts must never establish item-level waiting.
