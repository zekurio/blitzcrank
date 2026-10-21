import { Effect } from "effect"

import type { JsonValue } from "../../http.ts"
import { isJsonObject, isString, type JsonObject } from "../../json.ts"
import { ToolError, type ToolFailure } from "../../tools/errors.ts"
import {
  largestFitting,
  MAX_LIST_ITEMS,
  MAX_RESULT_CHARS,
} from "../../tools/results.ts"
import type { Arr } from "./client.ts"
import { scalar, scalars } from "./compact.ts"

/** A URL with user info, or a query that names a key, token, or password. */
const CREDENTIAL_SHAPED =
  /:\/\/[^/\s]*@|[?&](?:api_?key|token|pass(?:word|wd)?|secret)=/i

/**
 * One named download-client setting, looked up by its exact field name.
 * `null` is a setting this client does not report, which is not a false. A
 * field the Arr marks as a credential is never copied, whatever its name.
 */
function clientSetting(fields: readonly JsonObject[], name: string): JsonValue {
  const field = fields.find((entry) => entry.name === name)
  if (!field) return null
  if (field.privacy !== undefined && field.privacy !== "normal") return null
  const value = field.value
  return isString(value) && CREDENTIAL_SHAPED.test(value)
    ? "[withheld: it looks like it carries a credential]"
    : scalar(value)
}

/**
 * What a stall diagnosis needs of one download client: where it is, whether
 * it is used, and which category and directory this Arr hands it. The
 * client's settings list is never passed on.
 */
function compactDownloadClient(arr: Arr, client: JsonObject): JsonObject {
  if (!isString(client.name)) {
    throw new Error(`${arr.service} returned a download client without a name`)
  }
  const fields = client.fields
  // A setting that cannot be read by name would report as one the client
  // does not have.
  if (
    !Array.isArray(fields) ||
    !fields.every(isJsonObject) ||
    !fields.every((field) => isString(field.name))
  ) {
    throw new Error(
      `${arr.service} returned download client ${client.name} without a settings list that can be read`,
    )
  }
  const prefix = arr.clientSettingPrefix
  return {
    ...scalars(client, [
      "id",
      "name",
      "implementation",
      "protocol",
      "enable",
      "priority",
      "removeCompletedDownloads",
      "removeFailedDownloads",
    ]),
    host: clientSetting(fields, "host"),
    port: clientSetting(fields, "port"),
    useSsl: clientSetting(fields, "useSsl"),
    urlBase: clientSetting(fields, "urlBase"),
    category: clientSetting(fields, `${prefix}Category`),
    importedCategory: clientSetting(fields, `${prefix}ImportedCategory`),
    directory: clientSetting(fields, `${prefix}Directory`),
    watchFolder: clientSetting(fields, "watchFolder"),
  }
}

/**
 * A record of a diagnostic list, required to carry the string fields its
 * reading rests on. One without them is no finding, so it fails the read
 * instead of listing as a row of nulls.
 */
export function diagnosticRecord(
  arr: Arr,
  what: string,
  record: JsonObject,
  required: readonly string[],
): JsonObject {
  const missing = required.filter((key) => !isString(record[key]))
  if (missing.length > 0) {
    throw new Error(
      `${arr.service} returned a ${what} without a readable ${missing.join(", ")}`,
    )
  }
  return record
}

interface DownloadClientReads {
  clients: JsonObject[]
  mappings: JsonObject[]
  handling: JsonObject
}

/**
 * Clients, path mappings, and handling settings as one result. The two lists
 * share its room: the mappings are offered half of it first, the clients take
 * what that leaves, and the mappings then take what the clients left. Each
 * list says where it was cut.
 */
export function downloadClientsResult(
  arr: Arr,
  read: DownloadClientReads,
  offsets: {
    clientOffset?: number | undefined
    mappingOffset?: number | undefined
  },
): JsonObject {
  const clients = read.clients.map((client) =>
    compactDownloadClient(arr, client),
  )
  const mappings = read.mappings.map((mapping) =>
    scalars(
      diagnosticRecord(arr, "remote path mapping", mapping, PATH_MAPPING),
      ["id", ...PATH_MAPPING],
    ),
  )
  const clientOffset = offsets.clientOffset ?? 0
  const mappingOffset = offsets.mappingOffset ?? 0
  const clientPage = clients.slice(clientOffset, clientOffset + MAX_LIST_ITEMS)
  const mappingPage = mappings.slice(
    mappingOffset,
    mappingOffset + MAX_LIST_ITEMS,
  )
  const build = (clientCount: number, mappingCount: number): JsonObject => ({
    clients: listPart(
      clients.length,
      clientOffset,
      clientPage.slice(0, clientCount),
      "nextClientOffset",
    ),
    remotePathMappings: listPart(
      mappings.length,
      mappingOffset,
      mappingPage.slice(0, mappingCount),
      "nextMappingOffset",
    ),
    handling: scalars(read.handling, [
      "enableCompletedDownloadHandling",
      "autoRedownloadFailed",
      "autoRedownloadFailedFromInteractiveSearch",
    ]),
  })
  const chars = (clientCount: number, mappingCount: number) =>
    JSON.stringify(build(clientCount, mappingCount)).length
  const half = (MAX_RESULT_CHARS + chars(0, 0)) / 2
  const offered = largestFitting(
    mappingPage.length,
    (count) => chars(0, count) <= half,
  )
  const clientCount = largestFitting(
    clientPage.length,
    (count) => chars(count, Math.max(offered, 0)) <= MAX_RESULT_CHARS,
  )
  const mappingCount = largestFitting(
    mappingPage.length,
    (count) => chars(Math.max(clientCount, 0), count) <= MAX_RESULT_CHARS,
  )
  // Settings are bounded, so one entry of each list always fits. Should that
  // ever fail, a list that shows nothing must not pass for one that was read.
  if (
    clientCount < Math.min(1, clientPage.length) ||
    mappingCount < Math.min(1, mappingPage.length)
  ) {
    throw new Error(
      `${arr.service} download clients and path mappings do not fit one result of ${MAX_RESULT_CHARS} characters with an entry of each`,
    )
  }
  return build(clientCount, mappingCount)
}

const PATH_MAPPING = ["host", "remotePath", "localPath"] as const

/** One list of a result that holds several, with where to read on from. */
function listPart(
  total: number,
  offset: number,
  items: JsonObject[],
  nextKey: string,
): JsonObject {
  const reached = offset + items.length
  return {
    total,
    listed: items.length,
    ...(offset > 0 ? { offset } : {}),
    ...(reached < total ? { truncated: true, [nextKey]: reached } : {}),
    items,
  }
}

/**
 * A read one diagnostic is built from. Its failure names the part that could
 * not be read, so a partial answer is never taken for the whole one.
 */
export function component<A>(
  arr: Arr,
  what: string,
  read: Effect.Effect<A, ToolFailure>,
): Effect.Effect<A, ToolError> {
  return read.pipe(
    Effect.mapError(
      (error) =>
        new ToolError({
          message: `${arr.service} ${what} could not be read, so nothing is reported: ${error.message}`,
        }),
    ),
  )
}
