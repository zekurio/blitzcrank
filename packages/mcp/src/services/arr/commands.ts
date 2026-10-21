import { Effect } from "effect"

import type { JsonRequestError, JsonValue } from "../../http.ts"
import {
  isJsonObject,
  isNumber,
  objectField,
  pick,
  type JsonObject,
} from "../../json.ts"
import { toolFail, type ToolFailure } from "../../tools/errors.ts"
import { arrObject, arrRequest, type Arr } from "./client.ts"

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
