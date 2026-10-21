import { Type } from "typebox"

const PROVIDERS = ["Tmdb", "Tvdb", "Imdb"] as const
/** Jellyfin accepts an id with or without dashes and prints it without. */
const ID_PATTERN =
  "^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$"

export const itemIdParam = Type.String({
  pattern: ID_PATTERN,
  description: "Jellyfin item id, 32 hex digits",
})
export const userIdParam = Type.String({
  pattern: ID_PATTERN,
  description:
    "Jellyfin user id, 32 hex digits, from jellyfin_users or a Seerr user's jellyfinUserId. Never pick a user by display name",
})
export const providerParam = Type.Enum(PROVIDERS, {
  description: "The metadata provider the id belongs to",
})
export const providerIdParam = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9._-]+$",
  description:
    "The id at that provider, e.g. 603 for Tmdb or tt0133093 for Imdb",
})
