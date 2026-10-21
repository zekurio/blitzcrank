import type { ServiceConfig } from "../../config.ts"
import { defineReads } from "../../tools/reads.ts"
import type { ServerTool } from "../../tools/tool.ts"
import { defineWrites } from "../../tools/writes.ts"
import type { Arr } from "../arr/client.ts"
import { sonarrReads } from "./reads.ts"
import { sonarrActions } from "./writes.ts"

export function buildSonarrTools(cfg: ServiceConfig): ServerTool[] {
  const arr: Arr = {
    service: "sonarr",
    cfg,
    itemKey: "seriesId",
    itemNoun: "series",
    unknownItemsParam: "includeUnknownSeriesItems",
    itemHistoryPath: "/api/v3/history/series",
    clientSettingPrefix: "tv",
    scanCommand: "DownloadedEpisodesScan",
    eventTypes: {
      grabbed: 1,
      seriesFolderImported: 2,
      downloadFolderImported: 3,
      downloadFailed: 4,
      episodeFileDeleted: 5,
      episodeFileRenamed: 6,
      downloadIgnored: 7,
    },
  }
  const service = { name: "sonarr", label: "Sonarr (TV)" }
  return [
    ...defineReads(service, sonarrReads(arr)),
    ...defineWrites(service, sonarrActions(arr)),
  ]
}
