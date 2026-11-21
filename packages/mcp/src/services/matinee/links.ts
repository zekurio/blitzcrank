import { PROVIDERS, TITLE_KINDS, type CatalogRef } from "./client.ts"

/**
 * What a link to Matinee's web app names, read from its path alone. Nothing
 * fetches the link: a call goes to the configured Matinee origin with the id
 * taken from it, so a link to another server names nothing found here.
 */
export type LinkTarget =
  | { kind: "title"; titleId: string; season: number | undefined }
  | { kind: "item"; itemId: string }
  | { kind: "catalog"; ref: CatalogRef }

const ID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

// The web app's routes in `apps/web/src/routes/_authed/_shell` and
// `_authed/watch.$itemId.tsx`. A prefix before them is allowed, for a server
// behind a sub-path.
const TITLE = new RegExp(`(?:^|/)titles/(${ID})(?:/seasons/(\\d{1,4}))?/?$`)
const ITEM = new RegExp(`(?:^|/)(?:episodes|watch)/(${ID})/?$`)
const CATALOG =
  /(?:^|\/)catalog\/(movie|show)\/(tmdb|tvdb)\/([0-9A-Za-z]{1,256})\/?$/

export function parseLink(link: string): LinkTarget {
  const trimmed = link.trim()
  const path = URL.canParse(trimmed)
    ? new URL(trimmed).pathname
    : (trimmed.split(/[?#]/, 1)[0] ?? "")
  const title = TITLE.exec(path)
  if (title?.[1]) {
    return {
      kind: "title",
      titleId: title[1],
      season: title[2] === undefined ? undefined : Number(title[2]),
    }
  }
  const item = ITEM.exec(path)
  if (item?.[1]) return { kind: "item", itemId: item[1] }
  const catalog = CATALOG.exec(path)
  const kind = TITLE_KINDS.find((entry) => entry === catalog?.[1])
  const provider = PROVIDERS.find((entry) => entry === catalog?.[2])
  if (kind && provider && catalog?.[3]) {
    return { kind: "catalog", ref: { kind, provider, providerId: catalog[3] } }
  }
  throw new Error(
    "the link is not a Matinee title, season, episode, player, or catalog page: those paths are /titles/<id>, /titles/<id>/seasons/<n>, /episodes/<id>, /watch/<id>, and /catalog/<kind>/<provider>/<id>",
  )
}
