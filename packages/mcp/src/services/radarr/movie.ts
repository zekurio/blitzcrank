import { Type } from "typebox"

import type { Signal } from "../../http.ts"
import { names, objectField, pick, type JsonObject } from "../../json.ts"
import { arrObject, type Arr } from "../arr/client.ts"
import { qualityName, scalars } from "../arr/compact.ts"

export const movieIdParam = Type.Integer({
  minimum: 1,
  description: "Internal Radarr movie id (not tmdbId)",
})

export function readMovie(arr: Arr, movieId: number, signal: Signal) {
  return arrObject(arr, `/api/v3/movie/${movieId}`, `movie ${movieId}`, signal)
}

export function compactMovie(movie: JsonObject): JsonObject {
  const file = objectField(movie, "movieFile")
  return {
    ...pick(movie, [
      "id",
      "title",
      "year",
      "status",
      "monitored",
      "hasFile",
      "isAvailable",
      "minimumAvailability",
      "path",
      "qualityProfileId",
      "tmdbId",
      "imdbId",
      "inCinemas",
      "digitalRelease",
      "physicalRelease",
      "sizeOnDisk",
      "tags",
    ]),
    ...(file ? { movieFile: compactMovieFile(file) } : {}),
  }
}

export function compactMovieFile(file: JsonObject): JsonObject {
  return {
    ...pick(file, [
      "id",
      "movieId",
      "path",
      "size",
      "releaseGroup",
      "sceneName",
      "edition",
    ]),
    quality: qualityName(file.quality),
    ...scalars(file, ["qualityCutoffNotMet"]),
    languages: names(file.languages),
    mediaInfo: pick(objectField(file, "mediaInfo"), [
      "audioLanguages",
      "subtitles",
      "videoCodec",
      "audioCodec",
    ]),
  }
}

export function movieLabel(movie: JsonObject): string {
  return `${String(movie.title ?? `movie ${String(movie.id)}`)} (${String(movie.year ?? "unknown year")})`
}
