package tools

import "strings"

var baseToolDefs = []toolDef{
	{
		Name:        "seerr_get_request",
		Description: "Fetch a Jellyseerr/Overseerr request by request_id.",
		Parameters:  objectSchema(map[string]any{"request_id": stringSchema("Jellyseerr request id")}, []string{"request_id"}),
	},
	{
		Name:        "seerr_get_issue",
		Description: "Fetch a Jellyseerr/Overseerr issue by issue_id.",
		Parameters:  objectSchema(map[string]any{"issue_id": stringSchema("Jellyseerr issue id")}, []string{"issue_id"}),
	},
	{
		Name:        "seerr_resolve_issue",
		Description: "Mark a Jellyseerr/Overseerr issue as resolved after the fix has been validated with tools.",
		Parameters:  objectSchema(map[string]any{"issue_id": stringSchema("Jellyseerr issue id")}, []string{"issue_id"}),
		Mutating:    true,
	},
	{
		Name:        "jellyfin_search_items",
		Description: "Search Jellyfin library items by name.",
		Parameters:  objectSchema(map[string]any{"query": stringSchema("Movie, series, episode, or person search text")}, []string{"query"}),
	},
	{
		Name:        "jellyfin_list_items",
		Description: "List Jellyfin library items, optionally filtered by parent id, item type, search text, and recursion.",
		Parameters: objectSchema(map[string]any{
			"user_id":    stringSchema("Optional Jellyfin user id for user-scoped visibility and UserData"),
			"parent_id":  stringSchema("Optional parent Jellyfin item id, such as a library, series, season, folder, or collection"),
			"item_types": stringSchema("Optional comma-separated Jellyfin item types, such as Movie,Series,Season,Episode,Folder"),
			"query":      stringSchema("Optional item search text"),
			"recursive":  boolSchema("Whether to recurse under the parent item"),
			"limit":      numberSchema("Maximum items to return, from 1 to 100"),
		}, nil),
	},
	{
		Name:        "jellyfin_get_item",
		Description: "Fetch a Jellyfin item by item_id.",
		Parameters:  objectSchema(map[string]any{"item_id": stringSchema("Jellyfin item id")}, []string{"item_id"}),
	},
	{
		Name:        "jellyfin_get_item_media_info",
		Description: "Fetch concise Jellyfin media-source and stream metadata for one movie, episode, or video item, including available audio and subtitle tracks.",
		Parameters:  objectSchema(map[string]any{"item_id": stringSchema("Jellyfin item id")}, []string{"item_id"}),
	},
	{
		Name:        "jellyfin_get_child_media_info",
		Description: "Fetch concise Jellyfin media-source and stream metadata for video children under a series, season, folder, or collection item.",
		Parameters: objectSchema(map[string]any{
			"item_id": stringSchema("Parent Jellyfin item id"),
			"limit":   numberSchema("Maximum child video items to return, from 1 to 100"),
		}, []string{"item_id"}),
	},
	{
		Name:        "jellyfin_refresh_item",
		Description: "Refresh Jellyfin metadata for a known item id.",
		Parameters:  objectSchema(map[string]any{"item_id": stringSchema("Jellyfin item id")}, []string{"item_id"}),
		Mutating:    true,
	},
	{
		Name:        "jellyfin_list_libraries",
		Description: "List Jellyfin virtual library folders and their collection types.",
		Parameters:  objectSchema(map[string]any{}, nil),
	},
	{
		Name:        "jellyfin_list_users",
		Description: "List Jellyfin users visible to the configured API key.",
		Parameters:  objectSchema(map[string]any{}, nil),
	},
	{
		Name:        "jellyfin_find_user",
		Description: "Find Jellyfin users by name or id substring.",
		Parameters:  objectSchema(map[string]any{"query": stringSchema("Jellyfin username, display name, or user id text")}, []string{"query"}),
	},
	{
		Name:        "jellyfin_get_user",
		Description: "Fetch one Jellyfin user by user_id.",
		Parameters:  objectSchema(map[string]any{"user_id": stringSchema("Jellyfin user id")}, []string{"user_id"}),
	},
	{
		Name:        "jellyfin_get_user_views",
		Description: "List the library views visible to a Jellyfin user.",
		Parameters:  objectSchema(map[string]any{"user_id": stringSchema("Jellyfin user id")}, []string{"user_id"}),
	},
	{
		Name:        "jellyfin_get_user_item",
		Description: "Fetch a Jellyfin item from a user's perspective, including UserData such as played, favorite, playback position, and play count when Jellyfin returns it.",
		Parameters: objectSchema(map[string]any{
			"user_id": stringSchema("Jellyfin user id"),
			"item_id": stringSchema("Jellyfin item id"),
		}, []string{"user_id", "item_id"}),
	},
	{
		Name:        "jellyfin_get_item_user_data",
		Description: "Fetch only the Jellyfin UserData record for an item and user, including played, favorite, resume position, and play count fields.",
		Parameters: objectSchema(map[string]any{
			"user_id": stringSchema("Jellyfin user id"),
			"item_id": stringSchema("Jellyfin item id"),
		}, []string{"user_id", "item_id"}),
	},
	{
		Name:        "jellyfin_get_sessions",
		Description: "List active Jellyfin sessions and current playback state.",
		Parameters:  objectSchema(map[string]any{}, nil),
	},
	{
		Name:        "sonarr_get_series_by_tvdb_id",
		Description: "Find a Sonarr series by TVDB id.",
		Parameters:  objectSchema(map[string]any{"tvdb_id": stringSchema("TVDB id")}, []string{"tvdb_id"}),
	},
	{
		Name:        "sonarr_get_queue",
		Description: "Read the current Sonarr queue.",
		Parameters:  objectSchema(map[string]any{}, nil),
	},
	{
		Name:        "sonarr_get_blocklist",
		Description: "Read recent Sonarr blocklist entries for failed or corrupt releases.",
		Parameters:  objectSchema(map[string]any{"page_size": numberSchema("Maximum entries to return")}, nil),
	},
	{
		Name:        "sonarr_delete_blocklist_item",
		Description: "Remove one confirmed Sonarr blocklist item by id so Sonarr can search/download another release.",
		Parameters:  objectSchema(map[string]any{"blocklist_id": stringSchema("Sonarr blocklist item id")}, []string{"blocklist_id"}),
		Mutating:    true,
	},
	{
		Name:        "sonarr_get_episodes_by_series_id",
		Description: "List Sonarr episodes for a known series id so a specific missing episode can be searched.",
		Parameters:  objectSchema(map[string]any{"series_id": stringSchema("Sonarr series id")}, []string{"series_id"}),
	},
	{
		Name:        "sonarr_get_episode_file",
		Description: "Fetch Sonarr episode-file metadata by episode_file_id, including quality, languages, and mediaInfo when Sonarr has it.",
		Parameters:  objectSchema(map[string]any{"episode_file_id": stringSchema("Sonarr episode file id")}, []string{"episode_file_id"}),
	},
	{
		Name:        "sonarr_get_episode_files_by_series_id",
		Description: "List Sonarr episode-file metadata for a known series, optionally narrowed to one season, including quality, languages, and mediaInfo when Sonarr has it.",
		Parameters: objectSchema(map[string]any{
			"series_id":     stringSchema("Sonarr series id"),
			"season_number": stringSchema("Optional season number to narrow the file list"),
		}, []string{"series_id"}),
	},
	{
		Name:        "sonarr_search_episode",
		Description: "Trigger a Sonarr search for a specific episode id.",
		Parameters:  objectSchema(map[string]any{"episode_id": stringSchema("Sonarr episode id")}, []string{"episode_id"}),
		Mutating:    true,
	},
	{
		Name:        "sonarr_search_season",
		Description: "Trigger a Sonarr search for one season of a known series.",
		Parameters: objectSchema(map[string]any{
			"series_id":     stringSchema("Sonarr series id"),
			"season_number": stringSchema("Season number to search"),
		}, []string{"series_id", "season_number"}),
		Mutating: true,
	},
	{
		Name:        "sonarr_search_series",
		Description: "Trigger a Sonarr search for all monitored episodes of a known series.",
		Parameters:  objectSchema(map[string]any{"series_id": stringSchema("Sonarr series id")}, []string{"series_id"}),
		Mutating:    true,
	},
	{
		Name:        "sonarr_refresh_series",
		Description: "Trigger a Sonarr refresh/rescan command for a known series id.",
		Parameters:  objectSchema(map[string]any{"series_id": stringSchema("Sonarr series id")}, []string{"series_id"}),
		Mutating:    true,
	},
	{
		Name:        "sonarr_retry_queue_item",
		Description: "Retry/grab a known Sonarr queue item id.",
		Parameters:  objectSchema(map[string]any{"queue_id": stringSchema("Sonarr queue item id")}, []string{"queue_id"}),
		Mutating:    true,
	},
	{
		Name:        "radarr_get_movie_by_tmdb_id",
		Description: "Find a Radarr movie by TMDB id.",
		Parameters:  objectSchema(map[string]any{"tmdb_id": stringSchema("TMDB id")}, []string{"tmdb_id"}),
	},
	{
		Name:        "radarr_get_movie_by_id",
		Description: "Fetch a Radarr movie by movie_id, including movieFile metadata when Radarr has it.",
		Parameters:  objectSchema(map[string]any{"movie_id": stringSchema("Radarr movie id")}, []string{"movie_id"}),
	},
	{
		Name:        "radarr_get_movie_file",
		Description: "Fetch Radarr movie-file metadata by movie_file_id, including quality, languages, and mediaInfo when Radarr has it.",
		Parameters:  objectSchema(map[string]any{"movie_file_id": stringSchema("Radarr movie file id")}, []string{"movie_file_id"}),
	},
	{
		Name:        "radarr_get_queue",
		Description: "Read the current Radarr queue.",
		Parameters:  objectSchema(map[string]any{}, nil),
	},
	{
		Name:        "radarr_get_blocklist",
		Description: "Read recent Radarr blocklist entries for failed or corrupt releases.",
		Parameters:  objectSchema(map[string]any{"page_size": numberSchema("Maximum entries to return")}, nil),
	},
	{
		Name:        "radarr_delete_blocklist_item",
		Description: "Remove one confirmed Radarr blocklist item by id so Radarr can search/download another release.",
		Parameters:  objectSchema(map[string]any{"blocklist_id": stringSchema("Radarr blocklist item id")}, []string{"blocklist_id"}),
		Mutating:    true,
	},
	{
		Name:        "radarr_search_movie",
		Description: "Trigger a Radarr search for a specific movie id.",
		Parameters:  objectSchema(map[string]any{"movie_id": stringSchema("Radarr movie id")}, []string{"movie_id"}),
		Mutating:    true,
	},
	{
		Name:        "radarr_refresh_movie",
		Description: "Trigger a Radarr refresh/rescan command for a known movie id.",
		Parameters:  objectSchema(map[string]any{"movie_id": stringSchema("Radarr movie id")}, []string{"movie_id"}),
		Mutating:    true,
	},
	{
		Name:        "radarr_retry_queue_item",
		Description: "Retry/grab a known Radarr queue item id.",
		Parameters:  objectSchema(map[string]any{"queue_id": stringSchema("Radarr queue item id")}, []string{"queue_id"}),
		Mutating:    true,
	},
	{
		Name:        "sabnzbd_get_queue",
		Description: "Read the current SABnzbd queue for stuck or active download jobs.",
		Parameters:  objectSchema(map[string]any{}, nil),
	},
	{
		Name:        "sabnzbd_get_history",
		Description: "Read recent SABnzbd history for completed or failed download jobs.",
		Parameters:  objectSchema(map[string]any{"limit": numberSchema("Maximum history entries to return")}, nil),
	},
	{
		Name:        "fs_stat_path",
		Description: "Read metadata for a filesystem path under an allowed root.",
		Parameters:  objectSchema(map[string]any{"path": stringSchema("Absolute filesystem path to inspect")}, []string{"path"}),
	},
	{
		Name:        "fs_list_dir",
		Description: "List entries in a directory under an allowed root.",
		Parameters:  objectSchema(map[string]any{"path": stringSchema("Absolute directory path to list")}, []string{"path"}),
	},
	{
		Name:        "fs_find_recent",
		Description: "Find recently modified files under an allowed root.",
		Parameters: objectSchema(map[string]any{
			"root":  stringSchema("Absolute allowed root or subdirectory to search"),
			"limit": numberSchema("Maximum entries to return"),
		}, []string{"root"}),
	},
	{
		Name:        "fs_disk_usage",
		Description: "Report filesystem usage for an allowed root or subpath.",
		Parameters:  objectSchema(map[string]any{"path": stringSchema("Absolute path under an allowed root")}, []string{"path"}),
	},
}

func (r *Registry) OpenAITools() []any {
	return r.OpenAIToolsForPolicy(ToolPolicy{})
}

func (r *Registry) OpenAIToolsForPolicy(policy ToolPolicy) []any {
	defs := append([]toolDef{}, baseToolDefs...)
	if strings.TrimSpace(r.cfg.ExaAPIKey) != "" {
		defs = append(defs, toolDef{
			Name:        "web_search",
			Description: "Search the public web for current or external facts using Exa. Use after local media-server tools when an answer depends on outside facts, such as release availability, language/audio-track availability, schedules, or public metadata.",
			Parameters: objectSchema(map[string]any{
				"query": stringSchema("Search query"),
				"limit": numberSchema("Maximum search results to return, from 1 to 10"),
			}, []string{"query"}),
		})
	}
	out := make([]any, 0, len(defs))
	for _, def := range defs {
		if !r.toolAllowed(def, policy) {
			continue
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        def.Name,
				"description": def.Description,
				"parameters":  def.Parameters,
			},
		})
	}
	return out
}

func (r *Registry) ToolNamesForPolicy(policy ToolPolicy) []string {
	defs := append([]toolDef{}, baseToolDefs...)
	if strings.TrimSpace(r.cfg.ExaAPIKey) != "" {
		defs = append(defs, toolDef{Name: "web_search"})
	}
	names := make([]string, 0, len(defs))
	for _, def := range defs {
		if !r.toolAllowed(def, policy) {
			continue
		}
		names = append(names, def.Name)
	}
	return names
}

func (r *Registry) ToolAllowedForPolicy(name string, policy ToolPolicy) bool {
	def, ok := r.toolDef(name)
	if !ok {
		return false
	}
	return r.toolAllowed(def, policy)
}

func (r *Registry) IsMutatingTool(name string) bool {
	if name == "seerr_comment_issue" {
		return true
	}
	def, ok := r.toolDef(name)
	if !ok {
		return false
	}
	return def.Mutating
}

func (r *Registry) toolAllowed(def toolDef, policy ToolPolicy) bool {
	if policy.ReadOnly && def.Mutating {
		return false
	}
	if len(policy.Groups) == 0 {
		return true
	}
	return groupAllowed(toolGroup(def.Name), policy.Groups)
}

func (r *Registry) toolDef(name string) (toolDef, bool) {
	for _, def := range baseToolDefs {
		if def.Name == name {
			return def, true
		}
	}
	if name == "web_search" && strings.TrimSpace(r.cfg.ExaAPIKey) != "" {
		return toolDef{Name: "web_search"}, true
	}
	return toolDef{}, false
}

func toolGroup(name string) string {
	switch {
	case strings.HasPrefix(name, "seerr_"):
		return "jellyseerr"
	case strings.HasPrefix(name, "jellyfin_"):
		return "jellyfin"
	case strings.HasPrefix(name, "sonarr_"):
		return "sonarr"
	case strings.HasPrefix(name, "radarr_"):
		return "radarr"
	case strings.HasPrefix(name, "sabnzbd_"):
		return "sabnzbd"
	case strings.HasPrefix(name, "fs_"):
		return "filesystem"
	case name == "web_search":
		return "web"
	default:
		return ""
	}
}

func groupAllowed(group string, allowed []string) bool {
	for _, value := range allowed {
		if strings.EqualFold(strings.TrimSpace(value), group) {
			return true
		}
	}
	return false
}
