import type { ServiceConfig } from "../../config.ts"
import { defineReads } from "../../tools/reads.ts"
import type { ServerTool } from "../../tools/tool.ts"
import { defineWrites } from "../../tools/writes.ts"
import type { Arr } from "../arr/client.ts"
import { radarrReads } from "./reads.ts"
import { radarrActions } from "./writes.ts"

export function buildRadarrTools(cfg: ServiceConfig): ServerTool[] {
  const arr: Arr = {
    service: "radarr",
    cfg,
    itemKey: "movieId",
    itemNoun: "movie",
    unknownItemsParam: "includeUnknownMovieItems",
    itemHistoryPath: "/api/v3/history/movie",
    clientSettingPrefix: "movie",
    scanCommand: "DownloadedMoviesScan",
    eventTypes: {
      grabbed: 1,
      downloadFolderImported: 3,
      downloadFailed: 4,
      movieFileDeleted: 6,
      movieFolderImported: 7,
      movieFileRenamed: 8,
      downloadIgnored: 9,
    },
  }
  const service = { name: "radarr", label: "Radarr (movies)" }
  return [
    ...defineReads(service, radarrReads(arr)),
    ...defineWrites(service, radarrActions(arr)),
  ]
}
