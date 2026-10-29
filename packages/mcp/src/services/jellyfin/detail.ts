import type { JsonValue } from "../../http.ts"
import {
  isJsonObject,
  isString,
  objectField,
  pickOrNull,
  type JsonObject,
} from "../../json.ts"
import { fittingCount, MAX_LIST_ITEMS } from "../../tools/results.ts"
import { clip, clipStrings, MAX_NAME_CHARS, providerIdsOf } from "./compact.ts"

const MAX_DETAIL_OVERVIEW_CHARS = 2_000

const MAX_TAGS = 40

const MAX_REPEATED_PEOPLE = 20

export const NOT_RETURNED =
  "Jellyfin answered 404 for this item as this user, and separate reads found the item and the user. " +
  "Library access and parental rules are what usually hide an item from a user. The answer names no cause, and an item or user that changed between those reads looks the same"

const DETAIL_SCALARS = [
  "Id",
  "Name",
  "OriginalTitle",
  "SortName",
  "Type",
  "MediaType",
  "IsFolder",
  "LocationType",
  "Path",
  "ParentId",
  "SeriesId",
  "SeriesName",
  "SeasonId",
  "SeasonName",
  "IndexNumber",
  "IndexNumberEnd",
  "ParentIndexNumber",
  "ProductionYear",
  "PremiereDate",
  "EndDate",
  "DateCreated",
  "DateLastMediaAdded",
  "Status",
  "AirTime",
  "OfficialRating",
  "CustomRating",
  "CommunityRating",
  "CriticRating",
  "RunTimeTicks",
  "OriginalLanguage",
  "LockData",
] as const

const USER_DATA = [
  "Played",
  "PlayCount",
  "PlaybackPositionTicks",
  "PlayedPercentage",
  "UnplayedItemCount",
  "IsFavorite",
  "LastPlayedDate",
] as const

/**
 * The reviewed diagnostic projection of one item. Only named fields leave
 * here, so a field a later Jellyfin adds never reaches the model unreviewed.
 */
export function itemDetail(
  item: JsonObject,
  peopleStart: number,
  userView: JsonObject | undefined,
): JsonObject {
  const what = `item ${String(item.Id)}`
  const partial: string[] = []
  // `null` is a list Jellyfin did not send. One in another shape throws: a
  // dropped entry would leave a shorter list that reads as the whole one.
  const strings = (name: string, value: JsonValue | undefined): JsonValue => {
    if (value === undefined || value === null) return null
    if (!Array.isArray(value) || !value.every(isString)) {
      throw new Error(`jellyfin returned a malformed ${name} list for ${what}`)
    }
    if (value.length > MAX_TAGS) {
      partial.push(`${name} lists ${MAX_TAGS} of ${value.length}`)
    }
    return value.slice(0, MAX_TAGS).map((entry) => clip(entry, 100))
  }
  const people = peopleOf(item, what)
  const repeated = repeatedPeople(people ?? [])
  if (repeated !== null && repeated.length > MAX_REPEATED_PEOPLE) {
    partial.push(
      `People.repeated lists ${MAX_REPEATED_PEOPLE} of ${repeated.length}`,
    )
  }
  const base: JsonObject = {
    ...clipStrings(pickOrNull(item, DETAIL_SCALARS)),
    ProviderIds: providerIdsOf(item, what) ?? null,
    Overview: clip(item.Overview, MAX_DETAIL_OVERVIEW_CHARS),
    Taglines: strings("Taglines", item.Taglines),
    Genres: strings("Genres", item.Genres),
    Tags: strings("Tags", item.Tags),
    Studios: strings("Studios", studioNames(item, what)),
    AirDays: strings("AirDays", item.AirDays),
    LockedFields: strings("LockedFields", item.LockedFields),
    ...(userView ? { userView } : {}),
  }
  const page = people?.slice(peopleStart, peopleStart + MAX_LIST_ITEMS) ?? []
  const withPeople = (count: number): JsonObject => ({
    ...base,
    People: people
      ? {
          total: people.length,
          listed: count,
          ...(peopleStart > 0 ? { startIndex: peopleStart } : {}),
          ...(peopleStart + count < people.length
            ? { nextStartIndex: peopleStart + count }
            : {}),
          repeated: repeated?.slice(0, MAX_REPEATED_PEOPLE) ?? null,
          items: page.slice(0, count).map(compactPerson),
        }
      : null,
    ...(partial.length > 0 ? { partial } : {}),
  })
  return withPeople(
    fittingCount(page.length, withPeople, {
      entry: `the People entry at index ${peopleStart}`,
    }),
  )
}

/** Studio names, or `undefined` when Jellyfin sent no studio list. */
function studioNames(item: JsonObject, what: string): JsonValue | undefined {
  const studios = item.Studios
  if (studios === undefined || studios === null) return undefined
  const malformed = `jellyfin returned a malformed Studios list for ${what}`
  if (!Array.isArray(studios)) throw new Error(malformed)
  return studios.map((studio) => {
    if (!isJsonObject(studio) || !isString(studio.Name)) {
      throw new Error(malformed)
    }
    return studio.Name
  })
}

/** Cast and crew in Jellyfin's order, or `undefined` when it sent no list. */
function peopleOf(item: JsonObject, what: string): JsonObject[] | undefined {
  const people = item.People
  if (people === undefined || people === null) return undefined
  if (!Array.isArray(people) || !people.every(isJsonObject)) {
    throw new Error(`jellyfin returned a malformed People list for ${what}`)
  }
  return people
}

function compactPerson(person: JsonObject): JsonObject {
  return clipStrings(
    pickOrNull(person, ["Id", "Name", "Role", "Type"]),
    MAX_NAME_CHARS,
  )
}

/**
 * People listed more than once under one person Id, counted over the whole
 * list. One page of it cannot show that. `null` when an entry carries no Id
 * to count by, which leaves the repeats unknown.
 */
function repeatedPeople(people: readonly JsonObject[]): JsonObject[] | null {
  const counts = new Map<string, { name: JsonValue; entries: number }>()
  for (const person of people) {
    if (!isString(person.Id)) return null
    counts.set(person.Id, {
      name: clip(person.Name, MAX_NAME_CHARS),
      entries: (counts.get(person.Id)?.entries ?? 0) + 1,
    })
  }
  return [...counts]
    .filter(([, seen]) => seen.entries > 1)
    .map(([id, seen]) => ({ Id: id, Name: seen.name, entries: seen.entries }))
}

/** Whether Jellyfin returns the item to one user, and that user's state on it. */
export function userViewOf(
  userId: string,
  seen: JsonObject | undefined,
): JsonObject {
  if (seen === undefined) {
    return { userId, returned: false, meaning: NOT_RETURNED }
  }
  const userData = objectField(seen, "UserData")
  return {
    userId,
    returned: true,
    UserData: userData ? clipStrings(pickOrNull(userData, USER_DATA)) : null,
    ...clipStrings(pickOrNull(seen, ["ChildCount", "RecursiveItemCount"])),
  }
}
