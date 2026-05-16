---
name: automation-creator
description: Use when creating or editing Blitzcrank automation Markdown files under automations/ for scheduled agent-run maintenance, checks, reports, or safe repair workflows.
---

# Automation Creator

- Create one Markdown file per automation under `automations/`.
- Use YAML frontmatter with exactly these required fields: `name`, `description`, and `schedule`.
- `schedule` must be a robfig/cron-compatible descriptor or five-field cron expression. Do not use `daily`.
- Prefer explicit quoted cron strings such as `schedule: "cron: 0 9 * * *"` or descriptors such as `schedule: "@hourly"`.
- Keep automation prompts specific about scope, safe tools, validation, and German output.
- For maintenance jobs, prefer read/check/report first; allow mutating tools only when the automation states the exact safe condition and required validation.
- Automations should return a concise German operations summary.
- If the automation should not report to users, say that it should only report operational status.

Template:

```md
---
name: short-kebab-name
description: One sentence describing the automation.
schedule: "cron: 0 9 * * *"
---

Run ...

Use ...

Do not ...

Return a concise German operations summary with:

- Auffälligkeiten
- Aktionen
- Validierung
- Manuelle Schritte, falls nötig
```
