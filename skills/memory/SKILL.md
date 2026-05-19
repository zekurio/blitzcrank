---
name: memory
description: Durable Markdown memory workflow for recurring operational facts, blockers, user preferences, and manual-intervention decisions.
---

# Memory Skill

Use memory tools for durable facts that should survive this run, thread history limits, or context compaction.

Workflow:

1. Before recurring operational work, repeated user preference handling, known media blockers, or automation decisions, call `memory_list` or `memory_search` with the narrowest useful scope and key prefix.
2. Create or update memory with `memory_upsert` when tool evidence or an explicit user statement establishes a durable fact future runs should know.
3. Use stable scoped keys, such as `hourly-stale-import-handler/manual-intervention/<item>`, `<discord-user-id>/preferences`, `issues/<issue-id>`, `movies/<tmdb-id>`, or `shows/<tvdb-id>`.
4. Include compact Markdown content and metadata with stable identifiers when available.
5. Update or delete obsolete memories when current tool evidence proves they are wrong or resolved.

Rules:

- Do not store secrets, tokens, raw private logs, raw API responses, speculative conclusions, or unrelated personal data.
- For non-admin Discord users, only use `scope=discord_user` and keys under that requester's Discord user id.
- Memory writes are allowed even when the current media-server workflow is otherwise read-only.
