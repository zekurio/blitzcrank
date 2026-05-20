package tools

var baseToolDefs = []toolDef{
	{
		Name:        "thread_history_search",
		Description: "Search prior agent thread JSONL traces for similar investigations, fixes, or operational context. Use early for repeated symptoms, reopened issues, recurring automation blockers, or when a user says something happened again. Returns compact snippets and metadata only; use results as historical clues and validate current live state before acting.",
		Parameters: objectSchema(map[string]any{
			"query":             stringSchema("Search terms, such as a title, error, queue/import symptom, or prior fix to look for"),
			"source":            stringSchema("Optional source filter. Prefer exactly one of: all, discord, issues, or automations. Common aliases such as issue, seerr_issue, automation, and automation_cron are accepted."),
			"limit":             numberSchema("Optional maximum threads to return, from 1 to 10"),
			"exclude_thread_id": stringSchema("Optional current thread id or issue id to omit from results"),
		}, []string{"query"}),
	},
	{
		Name:        "sandbox_run_typescript",
		Description: "Run a short TypeScript diagnostic script in a Deno sandbox after an AI permission review. Use this for flexible service inspection instead of adding one-off service tools. Use only these configured service env vars: SEERR_BASE_URL/SEERR_API_KEY, JELLYFIN_BASE_URL/JELLYFIN_API_KEY, SONARR_BASE_URL/SONARR_API_KEY, RADARR_BASE_URL/RADARR_API_KEY, SABNZBD_BASE_URL/SABNZBD_API_KEY, BOT_TIMEZONE. Do not probe alternate env names such as *_URL; Deno throws when an ungranted env var is read.",
		Parameters: objectSchema(map[string]any{
			"purpose":         stringSchema("Why this script is needed and what facts it should collect"),
			"script":          stringSchema("TypeScript code to run with Deno. Use fetch with the documented *_BASE_URL and *_API_KEY env vars only, and print concise JSON or text evidence."),
			"safety_level":    stringSchema("Optional agent-proposed safety level: read_only, narrow_mutation, broad_mutation, or destructive"),
			"safety_reason":   stringSchema("Optional concise argument for why the requested script is safe enough for this workflow; the sandbox reviewer independently verifies it"),
			"timeout_seconds": numberSchema("Optional execution timeout from 1 to 60 seconds"),
		}, []string{"purpose", "script"}),
	},
}
