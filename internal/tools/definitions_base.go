package tools

var baseToolDefs = []toolDef{
	{
		Name:        "memory_list",
		Description: "List persisted agent memories, optionally narrowed by scope, key prefix, or tag. Use this to discover relevant operational memory before acting.",
		Parameters: objectSchema(map[string]any{
			"scope":      stringSchema("Optional top-level memory scope such as automation, discord_user, seerr_issue, seerr_movie, seerr_show, or general"),
			"key_prefix": stringSchema("Optional slash-separated key prefix within the scope, for example hourly-stale-import-handler/manual-intervention"),
			"tag":        stringSchema("Optional tag that must be present on the memory"),
			"limit":      numberSchema("Maximum memories to return, from 1 to 100"),
		}, nil),
	},
	{
		Name:        "memory_search",
		Description: "Search persisted agent memories by plain text query over scope, key, title, content, tags, and JSON metadata.",
		Parameters: objectSchema(map[string]any{
			"query": stringSchema("Search text"),
			"scope": stringSchema("Optional top-level memory scope to narrow the search"),
			"limit": numberSchema("Maximum memories to return, from 1 to 100"),
		}, []string{"query"}),
	},
	{
		Name:        "memory_get",
		Description: "Fetch one persisted agent memory by scope and slash-separated key.",
		Parameters: objectSchema(map[string]any{
			"scope": stringSchema("Top-level memory scope such as automation, discord_user, seerr_issue, seerr_movie, seerr_show, or general"),
			"key":   stringSchema("Slash-separated memory key inside the scope"),
		}, []string{"scope", "key"}),
	},
	{
		Name:        "memory_upsert",
		Description: "Create or update one persisted agent memory. Use scoped keys so operational memory is categorized cleanly instead of landing in one flat folder.",
		Parameters: objectSchema(map[string]any{
			"scope":    stringSchema("Top-level memory scope such as automation, discord_user, seerr_issue, seerr_movie, seerr_show, or general"),
			"key":      stringSchema("Slash-separated memory key inside the scope, for example hourly-stale-import-handler/manual-intervention/digimon-beatbreak-s01e31"),
			"title":    stringSchema("Short human-readable memory title"),
			"content":  stringSchema("The durable memory content"),
			"tags":     stringSchema("Optional comma-separated tags"),
			"metadata": stringSchema("Optional JSON object with stable identifiers such as queue_id, download_id, issue_id, tmdb_id, tvdb_id, or discord_user_id"),
		}, []string{"scope", "key", "content"}),
		Mutating:        true,
		ReadOnlyAllowed: true,
	},
	{
		Name:        "memory_delete",
		Description: "Delete one persisted agent memory by scope and slash-separated key when it is obsolete or wrong.",
		Parameters: objectSchema(map[string]any{
			"scope": stringSchema("Top-level memory scope"),
			"key":   stringSchema("Slash-separated memory key inside the scope"),
		}, []string{"scope", "key"}),
		Mutating:        true,
		ReadOnlyAllowed: true,
	},
	{
		Name:        "sandbox_run_typescript",
		Description: "Run a short TypeScript diagnostic script in a Deno sandbox after an AI permission review. Use this for flexible service inspection instead of adding one-off service tools.",
		Parameters: objectSchema(map[string]any{
			"purpose":         stringSchema("Why this script is needed and what facts it should collect"),
			"script":          stringSchema("TypeScript code to run with Deno. Use fetch for configured service APIs and print concise JSON or text evidence."),
			"timeout_seconds": numberSchema("Optional execution timeout from 1 to 60 seconds"),
		}, []string{"purpose", "script"}),
	},
}
