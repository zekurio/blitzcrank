package tools

var baseToolDefs = []toolDef{
	{
		Name:        "thread_history_search",
		Description: "Search prior agent thread JSONL traces for similar investigations, fixes, or operational context. Use early for repeated symptoms, reopened issues, recurring automation blockers, or when a user says something happened again. Returns compact snippets and metadata only; use results as historical clues and validate current live state before acting.",
		Parameters: objectSchema(map[string]any{
			"query":             stringSchema("Search terms, such as a title, error, queue/import symptom, or prior fix to look for"),
			"source":            stringSchema("Optional source filter. Prefer exactly one of: all, issues, or automations. Legacy discord traces may still be searched when present."),
			"limit":             numberSchema("Optional maximum threads to return, from 1 to 10"),
			"exclude_thread_id": stringSchema("Optional current thread id or issue id to omit from results"),
		}, []string{"query"}),
	},
}
