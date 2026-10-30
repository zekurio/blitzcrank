import { Effect } from "effect"
import { Type } from "typebox"

import type { JsonRequestError, JsonValue, Signal } from "../../http.ts"
import {
  isJsonObject,
  isNumber,
  objectField,
  pick,
  type JsonObject,
} from "../../json.ts"
import { toolFail, type ToolFailure } from "../../tools/errors.ts"
import { action, type Resolved } from "../../tools/writes.ts"
import { arrObject, arrRequest, type Arr } from "./client.ts"
import { itemIdOf, withItemId } from "./params.ts"

export function compactCommand(command: JsonObject): JsonObject {
  return {
    ...pick(command, [
      "id",
      "name",
      "status",
      "result",
      "message",
      "queued",
      "started",
      "ended",
      "duration",
      "exception",
    ]),
    body: pick(objectField(command, "body"), [
      "seriesId",
      "seasonNumber",
      "episodeIds",
      "movieId",
      "movieIds",
      "path",
      "importMode",
    ]),
  }
}

export function postCommand(arr: Arr, body: JsonObject) {
  return arrRequest(arr, "/api/v3/command", { method: "POST", body }).pipe(
    Effect.map((command) =>
      isJsonObject(command) ? compactCommand(command) : command,
    ),
  )
}

/**
 * Follow-up read on the queued command so the model sees it was accepted. A
 * response without a usable id is a verification that failed, never a write
 * that did not happen: the Arr answered the command with success.
 */
export function verifyCommand(
  arr: Arr,
  result: JsonValue,
): Effect.Effect<JsonValue, ToolFailure> {
  const id = isJsonObject(result) && isNumber(result.id) ? result.id : undefined
  if (id === undefined) {
    return toolFail(
      `${arr.service} accepted the command, but its answer carried no command id, so its status could not be read back. Do not send it again to get one: read the state it changes`,
    )
  }
  return arrObject(
    arr,
    `/api/v3/command/${id}`,
    `command ${id}`,
    undefined,
  ).pipe(Effect.map(compactCommand))
}

/** HTTP 404 on the record's own path is the proof a delete took effect. */
export function verifyDeleted(
  arr: Arr,
  path: string,
  label: string,
): Effect.Effect<JsonValue, JsonRequestError> {
  return arrRequest(arr, path).pipe(
    Effect.map(
      (): JsonValue => ({ warning: `${label} still present after delete` }),
    ),
    Effect.catchTag("HttpError", (error) =>
      error.status === 404
        ? Effect.succeed({ confirmed: `${label} no longer present (HTTP 404)` })
        : Effect.fail(error),
    ),
  )
}

const MONITORED_DOWNLOADS = "RefreshMonitoredDownloads"

interface ItemCommands {
  description: string
  /** The item's refresh and rescan commands. */
  names: readonly [string, string]
  idHelp: string
  read: (id: number, signal: Signal) => Effect.Effect<JsonObject, ToolFailure>
  label: (item: JsonObject) => string
  /** What a command for one item sends besides its name. */
  body: (name: string, id: number) => JsonObject
}

/**
 * The write that makes the Arr re-read one item's metadata or folder, or
 * every monitored download. Its state is the item's id, when it names one.
 */
export function runCommandAction(arr: Arr, commands: ItemCommands) {
  return action({
    description: commands.description,
    params: withItemId(
      arr,
      Type.Object({
        name: Type.Enum([...commands.names, MONITORED_DOWNLOADS]),
      }),
      commands.idHelp,
    ),
    resolve: (
      params,
      signal,
    ): Effect.Effect<Resolved<number | undefined>, ToolFailure> =>
      Effect.gen(function* () {
        const id = itemIdOf(arr, params)
        if (params.name === MONITORED_DOWNLOADS) {
          if (id !== undefined) {
            return yield* toolFail(
              `${MONITORED_DOWNLOADS} covers every download and takes no ${arr.itemKey}`,
            )
          }
          return {
            state: undefined,
            summary:
              "Re-check every monitored download in the download clients",
            effects: [
              {
                kind: "command",
                target: "download clients",
                detail: MONITORED_DOWNLOADS,
              },
            ],
            warnings: [],
          }
        }
        if (id === undefined) {
          return yield* toolFail(`${params.name} needs ${arr.itemKey}`)
        }
        const item = yield* commands.read(id, signal)
        return {
          state: id,
          summary: `${params.name} for ${commands.label(item)}`,
          effects: [
            {
              kind: "command",
              target: `${arr.itemNoun} ${id}: ${commands.label(item)}`,
              detail: `${params.name} over ${String(item.path ?? "its folder")}`,
            },
          ],
          warnings: [],
        }
      }),
    write: (params, id) =>
      postCommand(arr, {
        name: params.name,
        ...(id === undefined ? {} : commands.body(params.name, id)),
      }),
    verify: (_params, result) => verifyCommand(arr, result),
  })
}
