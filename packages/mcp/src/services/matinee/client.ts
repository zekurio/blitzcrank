import { Effect } from "effect"
import { Type } from "typebox"

import {
  jsonRequestEffect,
  type JsonRequestOptions,
  type JsonValue,
  type Signal,
} from "../../http.ts"
import { isJsonObject, objectList, type JsonObject } from "../../json.ts"
import {
  requireRecord,
  toolFail,
  type ToolFailure,
} from "../../tools/errors.ts"

/**
 * One Matinee account: the server's origin and that account's API token.
 * Matinee works out what an account sees, may request, and how a request
 * goes from the account itself, so which token a call carries decides its
 * answer.
 */
export interface MatineeAccount {
  url: string
  token: string
}

export const TITLE_KINDS = ["movie", "show"] as const
export const PROVIDERS = ["tmdb", "tvdb"] as const

export type TitleKind = (typeof TITLE_KINDS)[number]
export type Provider = (typeof PROVIDERS)[number]

/** A title at a metadata provider, as Matinee's catalog names one. */
export interface CatalogRef {
  kind: TitleKind
  provider: Provider
  providerId: string
}

const UUID =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"

export function uuidParam(description: string) {
  return Type.String({ pattern: UUID, description })
}

export const refParams = {
  kind: Type.Enum(TITLE_KINDS),
  provider: Type.Enum(PROVIDERS, {
    description: "tmdb for a Radarr tmdbId, tvdb for a Sonarr tvdbId",
  }),
  providerId: Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[0-9A-Za-z]+$",
  }),
}

/**
 * The REST form of Matinee's contract, under `/api/v1`. The token goes in a
 * header, so no URL and no error message carries it.
 */
export function matineeRequest(
  account: MatineeAccount,
  path: string,
  opts: JsonRequestOptions = {},
) {
  return jsonRequestEffect<JsonValue | undefined>(
    `${account.url}/api/v1`,
    path,
    {
      ...opts,
      headers: { Authorization: `Bearer ${account.token}` },
    },
  )
}

export function segment(id: string): string {
  return encodeURIComponent(id)
}

export function matineeRecord(
  account: MatineeAccount,
  path: string,
  what: string,
  signal: Signal,
  opts: JsonRequestOptions = {},
): Effect.Effect<JsonObject, ToolFailure> {
  return requireRecord(
    "matinee",
    what,
    matineeRequest(account, path, { ...opts, signal }),
  )
}

export function readTitle(
  account: MatineeAccount,
  titleId: string,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return matineeRecord(
    account,
    `/titles/${segment(titleId)}`,
    `title ${titleId}`,
    signal,
  )
}

export function readLibrary(
  account: MatineeAccount,
  libraryId: string,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return matineeRecord(
    account,
    `/libraries/${segment(libraryId)}`,
    `library ${libraryId}`,
    signal,
  )
}

export function readMediaItem(
  account: MatineeAccount,
  itemId: string,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return matineeRecord(
    account,
    `/media/${segment(itemId)}`,
    `file ${itemId}`,
    signal,
  )
}

/**
 * A list Matinee answers with: evidence of what exists, so anything but a
 * list is an error, never an empty answer.
 */
export function matineeList(
  what: string,
  request: Effect.Effect<JsonValue | undefined, ToolFailure>,
): Effect.Effect<JsonObject[], ToolFailure> {
  return request.pipe(
    Effect.flatMap((response) =>
      Array.isArray(response)
        ? Effect.succeed(objectList(response))
        : toolFail(`matinee returned no list of ${what}`),
    ),
  )
}

/** `POST /catalog/details`: a title at its provider, with what is here. */
export function catalogDetails(
  account: MatineeAccount,
  ref: CatalogRef,
  libraryId: string | undefined,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return matineeRequest(account, "/catalog/details", {
    method: "POST",
    body: {
      ref: {
        kind: ref.kind,
        provider: ref.provider,
        providerId: ref.providerId,
      },
      ...(libraryId !== undefined ? { libraryId } : {}),
    },
    signal,
    timeoutMs: 45_000,
  }).pipe(
    Effect.flatMap((response) =>
      isJsonObject(response)
        ? Effect.succeed(response)
        : toolFail(
            `matinee returned no details for ${ref.kind} ${ref.provider} ${ref.providerId}`,
          ),
    ),
  )
}
