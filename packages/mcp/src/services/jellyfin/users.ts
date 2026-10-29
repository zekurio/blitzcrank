import type { JsonValue } from "../../http.ts"
import {
  isJsonObject,
  isString,
  objectField,
  pick,
  pickOrNull,
  type JsonObject,
} from "../../json.ts"
import { clip, clipStrings } from "./compact.ts"

/** Entries one tag or item-type list of a policy keeps. */
const MAX_POLICY_TAGS = 40

const MAX_TAG_CHARS = 100

const MAX_ACCESS_SCHEDULES = 20

/**
 * One user's access, parental controls, and track preferences. Only named
 * fields leave here, and a policy list longer than its cap is cut, so one
 * user cannot fill the result. `partial` says which list was cut.
 */
export function compactUser(user: JsonObject): JsonObject {
  const what = `user ${String(user.Id)}`
  const policy = objectField(user, "Policy")
  const partial: string[] = []
  // A list Jellyfin did not send is left out. One in another shape throws: a
  // dropped entry would leave a shorter list that reads as the whole one.
  const list = <Entry extends JsonValue>(
    name: string,
    max: number,
    isEntry: (value: JsonValue) => value is Entry,
    compact: (entry: Entry) => JsonValue,
  ): JsonObject => {
    const value = policy?.[name]
    if (value === undefined || value === null) return {}
    if (!Array.isArray(value) || !value.every(isEntry)) {
      throw new Error(`jellyfin returned a malformed ${name} list for ${what}`)
    }
    if (value.length > max) {
      partial.push(`Policy.${name} lists ${max} of ${value.length}`)
    }
    return { [name]: value.slice(0, max).map(compact) }
  }
  const tag = (entry: string) => clip(entry, MAX_TAG_CHARS)
  const access: JsonObject = {
    ...pick(policy, [
      "IsAdministrator",
      "IsDisabled",
      "EnableAllFolders",
      "EnabledFolders",
      "EnableMediaPlayback",
      "EnableVideoPlaybackTranscoding",
    ]),
    // Jellyfin sends no MaxParentalRating for an account without a limit,
    // and MaxParentalSubRating only from 10.11 on.
    ...clipStrings(pick(policy, ["MaxParentalRating", "MaxParentalSubRating"])),
    ...list("BlockUnratedItems", MAX_POLICY_TAGS, isString, tag),
    ...list("BlockedTags", MAX_POLICY_TAGS, isString, tag),
    ...list("AllowedTags", MAX_POLICY_TAGS, isString, tag),
    ...list("AccessSchedules", MAX_ACCESS_SCHEDULES, isJsonObject, (schedule) =>
      clipStrings(
        pickOrNull(schedule, ["DayOfWeek", "StartHour", "EndHour"]),
        MAX_TAG_CHARS,
      ),
    ),
  }
  return {
    ...pick(user, ["Id", "Name", "LastActivityDate"]),
    Policy: access,
    Configuration: pick(objectField(user, "Configuration"), [
      "AudioLanguagePreference",
      "PlayDefaultAudioTrack",
      "SubtitleLanguagePreference",
      "SubtitleMode",
    ]),
    ...(partial.length > 0 ? { partial } : {}),
  }
}
