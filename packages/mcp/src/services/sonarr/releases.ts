import {
  isNumber,
  numberList,
  objectList,
  type JsonObject,
} from "../../json.ts"
import type { ReleaseTarget } from "../arr/releases.ts"

interface ReleaseParams {
  episodeId?: number | undefined
  seriesId?: number | undefined
  seasonNumber?: number | undefined
}

export function releaseTarget(params: ReleaseParams): ReleaseTarget {
  if (params.episodeId !== undefined) {
    if (params.seriesId !== undefined || params.seasonNumber !== undefined) {
      throw new Error(
        "pass either episodeId or seriesId with seasonNumber, not both",
      )
    }
    const episodeId = params.episodeId
    return {
      path: `/api/v3/release?episodeId=${episodeId}`,
      matches: (release) => mappedEpisodeIds(release).includes(episodeId),
      describe: describeMappedEpisodes,
    }
  }
  if (params.seriesId === undefined || params.seasonNumber === undefined) {
    throw new Error("pass episodeId, or seriesId with seasonNumber")
  }
  const seriesId = params.seriesId
  const seasonNumber = params.seasonNumber
  return {
    path: `/api/v3/release?seriesId=${seriesId}&seasonNumber=${seasonNumber}`,
    matches: (release) =>
      release.mappedSeriesId === seriesId &&
      release.mappedSeasonNumber === seasonNumber,
    describe: describeMappedEpisodes,
  }
}

function mappedEpisodeIds(release: JsonObject) {
  return objectList(release.mappedEpisodeInfo).flatMap((episode) =>
    isNumber(episode.id) ? [episode.id] : [],
  )
}

/** Scene and absolute numbering is where wrong-episode grabs show up. */
function describeMappedEpisodes(release: JsonObject) {
  const season = release.mappedSeasonNumber
  const episodes = numberList(release.mappedEpisodeNumbers)
  const absolute = numberList(release.mappedAbsoluteEpisodeNumbers)
  return {
    episodes:
      release.fullSeason === true
        ? `S${season} full season`
        : `S${season}E${episodes.join(",")}`,
    ...(absolute.length > 0 ? { absolute } : {}),
  }
}
