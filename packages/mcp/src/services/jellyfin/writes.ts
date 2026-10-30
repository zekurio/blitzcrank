import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../../config.ts"
import type { JsonValue } from "../../http.ts"
import { toolCheck } from "../../tools/errors.ts"
import { action, type WriteEffect } from "../../tools/writes.ts"
import { itemKey, jellyfinRequest, MEDIA_FIELDS, readItem } from "./client.ts"
import { itemLabel, providerIdsOf } from "./compact.ts"
import { itemIdParam, providerIdParam, providerParam } from "./params.ts"
import {
  exactCandidate,
  readBackItem,
  rematchReadBack,
  rematchType,
  remoteSearch,
} from "./rematch.ts"

/** A rematch refreshes the item, and for a series every child, before it answers. */
const REMATCH_TIMEOUT_MS = 90_000

/**
 * A write has 45 s to resolve its target. The item read and the search a
 * rematch resolves with fit inside that together, so their own timeouts
 * report first.
 */
const RESOLVE_ITEM_TIMEOUT_MS = 8_000
const RESOLVE_SEARCH_TIMEOUT_MS = 35_000

const REFRESH_MODES = [
  "None",
  "ValidationOnly",
  "Default",
  "FullRefresh",
] as const

export function jellyfinActions(cfg: ServiceConfig) {
  return {
    refresh_item: action({
      description:
        "Refresh one item's metadata, images, and file probe. Runs in the background",
      params: Type.Object({
        itemId: itemIdParam,
        metadataRefreshMode: Type.Optional(
          Type.Enum(REFRESH_MODES, { description: "Default: Default" }),
        ),
        imageRefreshMode: Type.Optional(
          Type.Enum(REFRESH_MODES, { description: "Default: Default" }),
        ),
        replaceAllMetadata: Type.Optional(
          Type.Boolean({ description: "Discard the stored metadata first" }),
        ),
        replaceAllImages: Type.Optional(
          Type.Boolean({ description: "Discard the stored artwork first" }),
        ),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const item = yield* readItem(cfg, params.itemId, signal)
          const effect: WriteEffect = {
            kind: "refresh",
            target: itemLabel(item),
            detail: [
              `path ${String(item.Path ?? "none")}`,
              `metadata ${params.metadataRefreshMode ?? "Default"}`,
              `images ${params.imageRefreshMode ?? "Default"}`,
            ].join("; "),
          }
          return {
            state: null,
            summary: `Refresh ${itemLabel(item)}`,
            effects: [effect],
            warnings: [
              ...(params.replaceAllMetadata === true
                ? ["the stored metadata is replaced, manual edits included"]
                : []),
              ...(params.replaceAllImages === true
                ? ["the stored artwork is replaced"]
                : []),
            ],
          }
        }),
      write: (params) =>
        jellyfinRequest(cfg, `/Items/${itemKey(params.itemId)}/Refresh`, {
          method: "POST",
          query: {
            Recursive: true,
            MetadataRefreshMode: params.metadataRefreshMode ?? "Default",
            ImageRefreshMode: params.imageRefreshMode ?? "Default",
            ReplaceAllMetadata: params.replaceAllMetadata ?? false,
            ReplaceAllImages: params.replaceAllImages ?? false,
          },
        }).pipe(
          Effect.map(
            (): JsonValue => ({
              queued: "refresh accepted; Jellyfin runs it in the background",
            }),
          ),
        ),
      verify: (params) =>
        readItem(cfg, params.itemId, undefined, { fields: MEDIA_FIELDS }).pipe(
          Effect.flatMap((item) => toolCheck(() => readBackItem(item))),
        ),
    }),
    apply_remote_search: action({
      description:
        "Rematch one item to the metadata-provider candidate carrying a provider id, replacing its provider ids and all of its metadata. " +
        "It searches the providers again and applies only a candidate they return now. " +
        "Jellyfin answers once it has refreshed the item, and for a series every season and episode. A long series can outlast that wait: the call then ends with an unknown outcome, which stops the run for operator review and is never retried",
      params: Type.Object({
        itemId: itemIdParam,
        provider: providerParam,
        providerId: providerIdParam,
        searchProviderName: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 100,
            description:
              "Only when several different candidates carry that id: the SearchProviderName of the one to apply",
          }),
        ),
        replaceAllImages: Type.Optional(
          Type.Boolean({ description: "Default true" }),
        ),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const item = yield* readItem(cfg, params.itemId, signal, {
            timeoutMs: RESOLVE_ITEM_TIMEOUT_MS,
          })
          const type = yield* rematchType(item)
          const found = yield* remoteSearch(
            cfg,
            type,
            { provider: params.provider, providerId: params.providerId },
            params.itemId,
            signal,
            RESOLVE_SEARCH_TIMEOUT_MS,
          )
          const candidate = yield* toolCheck(() =>
            exactCandidate(found, params),
          )
          const current = yield* toolCheck(() =>
            providerIdsOf(item, itemLabel(item)),
          )
          const match = `${candidate.Name ?? "unnamed"} (${String(candidate.ProductionYear ?? "unknown year")})`
          const rematch: WriteEffect = {
            kind: "rematch",
            target: itemLabel(item),
            detail: [
              `path ${String(item.Path ?? "none")}`,
              `provider ids ${current ? JSON.stringify(current) : "unknown"} replaced by ${JSON.stringify(candidate.ProviderIds)}`,
              `new match ${match} from ${candidate.SearchProviderName ?? "an unnamed search provider"}`,
              (params.replaceAllImages ?? true)
                ? "all images replaced"
                : "images kept",
            ].join("; "),
          }
          const children: WriteEffect = {
            kind: "refresh",
            target: `every season and episode of ${itemLabel(item)}`,
            detail: "metadata and images refreshed from the new match",
          }
          return {
            state: { candidate },
            summary: `Rematch ${itemLabel(item)} to ${match}`,
            effects: item.Type === "Series" ? [rematch, children] : [rematch],
            warnings: [
              "all metadata of the item is replaced by the new match",
              ...(item.Type === "Series"
                ? ["a series rematch also refreshes every season and episode"]
                : []),
            ],
          }
        }),
      write: (params, state) =>
        jellyfinRequest(
          cfg,
          `/Items/RemoteSearch/Apply/${itemKey(params.itemId)}`,
          {
            method: "POST",
            query: { ReplaceAllImages: params.replaceAllImages ?? true },
            // Only what an Apply reads, each from the live candidate.
            body: {
              ...(state.candidate.Name !== undefined
                ? { Name: state.candidate.Name }
                : {}),
              ...(state.candidate.ProductionYear !== undefined
                ? { ProductionYear: state.candidate.ProductionYear }
                : {}),
              ...(state.candidate.SearchProviderName !== undefined
                ? { SearchProviderName: state.candidate.SearchProviderName }
                : {}),
              ProviderIds: state.candidate.ProviderIds,
            },
            timeoutMs: REMATCH_TIMEOUT_MS,
          },
        ).pipe(Effect.map((): JsonValue => ({ applied: "rematch accepted" }))),
      verify: (params, _result, state) =>
        readItem(cfg, params.itemId, undefined, { fields: MEDIA_FIELDS }).pipe(
          Effect.flatMap((item) =>
            toolCheck(() => rematchReadBack(item, state.candidate.ProviderIds)),
          ),
        ),
    }),
  }
}
