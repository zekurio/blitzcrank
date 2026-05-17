package tools

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
		Name:        "seerr_search_media",
		Description: "Search Jellyseerr/Overseerr for movies or TV series by title so a request can be created against the correct media id.",
		Parameters: objectSchema(map[string]any{
			"query": stringSchema("Movie or TV title search text"),
			"page":  numberSchema("Optional result page, starting at 1"),
		}, []string{"query"}),
	},
	{
		Name:        "seerr_get_user",
		Description: "Fetch one Jellyseerr/Overseerr user by user_id. Use this before requesting on behalf of another user.",
		Parameters:  objectSchema(map[string]any{"user_id": stringSchema("Jellyseerr user id; defaults to the mapped Discord requester when omitted by the runtime")}, nil),
	},
	{
		Name:        "seerr_get_user_quota",
		Description: "Fetch Jellyseerr/Overseerr request quota state for one user. Use this before creating a request.",
		Parameters:  objectSchema(map[string]any{"user_id": stringSchema("Jellyseerr user id; defaults to the mapped Discord requester when omitted by the runtime")}, nil),
	},
	{
		Name:        "seerr_request_media",
		Description: "Create a Jellyseerr/Overseerr movie or TV request for a specific user after validating the target media and quota. Prefer this over direct Sonarr/Radarr add actions for new acquisition requests.",
		Parameters: objectSchema(map[string]any{
			"user_id":    stringSchema("Jellyseerr user id; defaults to the mapped Discord requester when omitted by the runtime"),
			"media_type": stringSchema("Media type: movie or tv"),
			"media_id":   stringSchema("TMDB media id from Jellyseerr search or details"),
			"seasons":    stringSchema("Optional comma-separated season numbers for partial TV requests; omit to request all seasons"),
			"is_4k":      boolSchema("Whether to create the request in 4K mode"),
		}, []string{"media_type", "media_id"}),
		Mutating: true,
	},
	{
		Name:        "seerr_comment_issue",
		Description: "Add a Jellyseerr/Overseerr issue comment after validating useful context with tools.",
		Parameters: objectSchema(map[string]any{
			"issue_id": stringSchema("Jellyseerr issue id"),
			"message":  stringSchema("Comment text to add to the issue"),
		}, []string{"issue_id", "message"}),
		Mutating: true,
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
		Name:        "sonarr_lookup_series",
		Description: "Search Sonarr's series lookup by title or external id before deciding whether a show can be added or matched.",
		Parameters:  objectSchema(map[string]any{"term": stringSchema("Series title or external id to look up")}, []string{"term"}),
	},
	{
		Name:        "sonarr_list_series",
		Description: "List all Sonarr series so the agent can quickly check whether a show is already tracked.",
		Parameters:  objectSchema(map[string]any{}, nil),
	},
	{
		Name:        "sonarr_get_wanted_missing",
		Description: "List monitored Sonarr episodes that are currently missing.",
		Parameters: objectSchema(map[string]any{
			"page":      numberSchema("Optional page number, defaults to 1"),
			"page_size": numberSchema("Optional maximum entries to return, defaults to 50"),
		}, nil),
	},
	{
		Name:        "sonarr_get_history",
		Description: "Read recent Sonarr history, optionally narrowed to one series id.",
		Parameters: objectSchema(map[string]any{
			"series_id": stringSchema("Optional Sonarr series id to narrow history"),
			"page":      numberSchema("Optional page number, defaults to 1"),
			"page_size": numberSchema("Optional maximum entries to return, defaults to 50"),
		}, nil),
	},
	{
		Name:        "sonarr_get_calendar",
		Description: "Read Sonarr calendar entries, optionally constrained by start and end date/time.",
		Parameters: objectSchema(map[string]any{
			"start":       stringSchema("Optional start date/time accepted by Sonarr, for example 2026-05-17"),
			"end":         stringSchema("Optional end date/time accepted by Sonarr, for example 2026-05-24"),
			"unmonitored": boolSchema("Whether to include unmonitored episodes"),
		}, nil),
	},
	{
		Name:        "sonarr_get_system_status",
		Description: "Read Sonarr system status including app name, version, OS, and runtime information.",
		Parameters:  objectSchema(map[string]any{}, nil),
	},
	{
		Name:        "sonarr_list_quality_profiles",
		Description: "List Sonarr quality profiles for interpreting monitored settings and future add workflows.",
		Parameters:  objectSchema(map[string]any{}, nil),
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
		Destructive: true,
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
		Name:        "sonarr_list_manual_import",
		Description: "List Sonarr manual import candidates for a completed download id or folder. Use this before importing stale completed downloads.",
		Parameters: objectSchema(map[string]any{
			"download_id":           stringSchema("Optional Sonarr downloadId from the queue/trackedDownload"),
			"folder":                stringSchema("Optional absolute folder or file path to inspect"),
			"series_id":             stringSchema("Optional Sonarr series id to narrow candidates"),
			"season_number":         stringSchema("Optional season number to narrow candidates"),
			"filter_existing_files": boolSchema("Whether Sonarr should filter existing files"),
		}, nil),
	},
	{
		Name:        "sonarr_import_manual_candidate",
		Description: "Import one safe Sonarr manual import candidate returned by sonarr_list_manual_import. Use force only when rejections are import-blocker warnings and tool evidence confirms the candidate is the correct target.",
		Parameters: objectSchema(map[string]any{
			"candidate_json": stringSchema("One complete candidate object from sonarr_list_manual_import, encoded as JSON"),
			"import_mode":    stringSchema("Import mode, usually Move"),
			"force":          boolSchema("Allow importing a candidate with explicit rejections after independent validation"),
		}, []string{"candidate_json"}),
		Mutating: true,
	},
	{
		Name:        "radarr_get_movie_by_tmdb_id",
		Description: "Find a Radarr movie by TMDB id.",
		Parameters:  objectSchema(map[string]any{"tmdb_id": stringSchema("TMDB id")}, []string{"tmdb_id"}),
	},
	{
		Name:        "radarr_lookup_movie",
		Description: "Search Radarr's movie lookup by title or external id before deciding whether a movie can be added or matched.",
		Parameters:  objectSchema(map[string]any{"term": stringSchema("Movie title or external id to look up")}, []string{"term"}),
	},
	{
		Name:        "radarr_list_movies",
		Description: "List all Radarr movies so the agent can quickly check whether a movie is already tracked.",
		Parameters:  objectSchema(map[string]any{}, nil),
	},
	{
		Name:        "radarr_get_wanted_missing",
		Description: "List monitored Radarr movies that are currently missing.",
		Parameters: objectSchema(map[string]any{
			"page":      numberSchema("Optional page number, defaults to 1"),
			"page_size": numberSchema("Optional maximum entries to return, defaults to 50"),
		}, nil),
	},
	{
		Name:        "radarr_get_history",
		Description: "Read recent Radarr history, optionally narrowed to one movie id.",
		Parameters: objectSchema(map[string]any{
			"movie_id":  stringSchema("Optional Radarr movie id to narrow history"),
			"page":      numberSchema("Optional page number, defaults to 1"),
			"page_size": numberSchema("Optional maximum entries to return, defaults to 50"),
		}, nil),
	},
	{
		Name:        "radarr_get_calendar",
		Description: "Read Radarr calendar entries, optionally constrained by start and end date/time.",
		Parameters: objectSchema(map[string]any{
			"start":       stringSchema("Optional start date/time accepted by Radarr, for example 2026-05-17"),
			"end":         stringSchema("Optional end date/time accepted by Radarr, for example 2026-05-24"),
			"unmonitored": boolSchema("Whether to include unmonitored movies"),
		}, nil),
	},
	{
		Name:        "radarr_get_system_status",
		Description: "Read Radarr system status including app name, version, OS, and runtime information.",
		Parameters:  objectSchema(map[string]any{}, nil),
	},
	{
		Name:        "radarr_list_quality_profiles",
		Description: "List Radarr quality profiles for interpreting monitored settings and future add workflows.",
		Parameters:  objectSchema(map[string]any{}, nil),
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
		Destructive: true,
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
		Name:        "radarr_list_manual_import",
		Description: "List Radarr manual import candidates for a completed download id or folder. Use this before importing stale completed downloads.",
		Parameters: objectSchema(map[string]any{
			"download_id":           stringSchema("Optional Radarr downloadId from the queue/trackedDownload"),
			"folder":                stringSchema("Optional absolute folder or file path to inspect"),
			"movie_id":              stringSchema("Optional Radarr movie id to narrow candidates"),
			"filter_existing_files": boolSchema("Whether Radarr should filter existing files"),
		}, nil),
	},
	{
		Name:        "radarr_import_manual_candidate",
		Description: "Import one safe Radarr manual import candidate returned by radarr_list_manual_import using Radarr's ManualImport command. Use force only when rejections are import-blocker warnings and tool evidence confirms the candidate is the correct target.",
		Parameters: objectSchema(map[string]any{
			"candidate_json": stringSchema("One complete candidate object from radarr_list_manual_import, encoded as JSON"),
			"import_mode":    stringSchema("Import mode, usually auto for Radarr"),
			"force":          boolSchema("Allow importing a candidate with explicit rejections after independent validation"),
		}, []string{"candidate_json"}),
		Mutating: true,
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
