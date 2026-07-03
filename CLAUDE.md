@AGENTS.md

## Picking the right models

Rankings, higher = better. Cost reflects what I actually pay (OpenAI has really generous limits), not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

| model    | cost | intelligence | taste |
| -------- | ---- | ------------- | ----- |
| gpt-5.5  | 9    | 8             | 5     |
| sonnet-5 | 6    | 5             | 7     |
| opus-4.8 | 4    | 8             | 8     |
| fable-5  | 2    | 9             | 9     |

How to apply:

- These are defaults, not limits. You have standing permission to override them: if a cheaper model's output doesn't meet the bar, rerun or redo the work with a smarter model without asking. Judge the output, not the price tag. Escalating costs less than shipping mediocre work.
- Cost is a tie-breaker only; when axes conflict for anything that ships, intelligence > taste > cost.
- Bulk/mechanical work (clear-spec implementation, data analysis, migrations): gpt-5.5 - it's very cheap and token efficient.
- Anything user-facing (UI, copy, API design) needs taste >= 7.
- Reviews of plans/implementations: fable-5 or opus-4.8, optionally gpt-5.5 as an extra independent perspective.
- Never use Haiku.
- Mechanics: gpt-5.5 is handled natively via the `openai/codex-plugin-cc` plugin inside Claude Code, automatically adopting your user-level configurations from `~/.codex/config.toml`. Avoid writing custom bash scripts; instead, utilize the plugin's built-in tools and skills:
  - `/codex:review` - Run non-destructive, read-only code quality assessments. Supports `--base <ref>` for branch analysis.
  - `/codex:adversarial-review` - Perform a skeptical design review to pressure-test tradeoffs, auth, and reliability. Append custom focus text at the end of the command to steer the focus.
  - `/codex:rescue` - Subcontract active debugging, multi-file refactoring, or implementation loops to Codex when a second pass is required.
  - `/codex:status` / `/codex:result` / `/codex:cancel` - Use these to check, fetch, or abort asynchronous jobs when using the `--background` flag on heavy tasks.
