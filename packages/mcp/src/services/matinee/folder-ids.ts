import type { JsonObject } from "../../json.ts"

// Matinee's own pattern, from `apps/server/src/media/title.ts`: Sonarr,
// Radarr, and Jellyfin put ids in folder names, like `Show (2008)
// {tvdb-81189}`, `Movie [tmdbid-603]`, or `[imdbid-tt0133093]`.
const ID_TAG = /[[{](tmdb|tvdb|imdb)(?:id)?[-=]([a-z0-9]+)[\]}]/gi

/**
 * The provider ids in the last part of a title's path. Matinee matches a
 * title to these before its stored match, so a tag that disagrees with that
 * match wins at the next refresh.
 */
export function folderIds(path: string): Record<string, string> {
  const last = path.split("/").findLast((part) => part !== "") ?? ""
  return Object.fromEntries(
    [...last.matchAll(ID_TAG)].flatMap((match) =>
      match[1] && match[2] ? [[match[1].toLowerCase(), match[2]]] : [],
    ),
  )
}

/**
 * Warnings for a write that matches a title again: what the folder name will
 * do to the match `providerId` leaves it with.
 */
export function folderTagWarnings(
  title: JsonObject,
  provider: string,
  providerId: string | undefined,
  when: "now" | "later",
): string[] {
  const tagged = folderIds(String(title.path ?? ""))[provider]
  if (tagged === undefined || tagged === providerId) return []
  return when === "now"
    ? [
        `the folder name carries ${provider}-${tagged}, which wins over the stored match ${String(providerId ?? "none")}: this refresh matches the title to ${provider} ${tagged} and drops the images an admin chose from the provider; uploaded images stay`,
      ]
    : [
        `the folder name carries ${provider}-${tagged}, which wins over this match at the next refresh, so Matinee undoes it on its own; renaming the folder in the Arr is what lasts`,
      ]
}
