import { Effect } from "effect"
import { Type } from "typebox"

import { pick } from "../../json.ts"
import { toolCheck, toolFail } from "../../tools/errors.ts"
import { resource } from "../../tools/reads.ts"
import { listResult } from "../../tools/results.ts"
import {
  arrList,
  arrObject,
  readBlocklist,
  readDownloadHandling,
  readQueue,
  type Arr,
} from "./client.ts"
import { compactCommand } from "./commands.ts"
import {
  compactBlocklistItem,
  compactQualityProfile,
  compactQueueItem,
  scalars,
} from "./compact.ts"
import {
  component,
  diagnosticRecord,
  downloadClientsResult,
  readHealth,
} from "./diagnostics.ts"
import { historyRead } from "./history.ts"
import {
  compactCandidate,
  manualImportScope,
  readCandidates,
} from "./manual-import.ts"
import { itemIdOf, offsetParam, withItemId } from "./params.ts"

/** The reads both Arrs serve from the same endpoints. */
export function arrSharedReads(arr: Arr) {
  const itemIdHelp = `Internal ${arr.service} ${arr.itemNoun} id; omit for every ${arr.itemNoun}`
  return {
    queue: resource({
      description: `Download queue. Without ${arr.itemKey} the whole queue, unknown items included`,
      params: withItemId(arr, Type.Object({ offset: offsetParam }), itemIdHelp),
      run: (params, signal) =>
        Effect.gen(function* () {
          const queue = yield* readQueue(arr, signal)
          const wanted = itemIdOf(arr, params)
          const offset = params.offset
          if (wanted === undefined) {
            return listResult(queue.records.map(compactQueueItem), {
              total: queue.total,
              offset,
            })
          }
          return listResult(
            queue.records
              .filter((item) => item[arr.itemKey] === wanted)
              .map(compactQueueItem),
            { offset },
          )
        }),
    }),
    history: historyRead(arr),
    blocklist: resource({
      description: "Blocklisted releases, newest first",
      params: withItemId(arr, Type.Object({ offset: offsetParam }), itemIdHelp),
      run: (params, signal) =>
        Effect.gen(function* () {
          const blocklist = yield* readBlocklist(arr, signal)
          const wanted = itemIdOf(arr, params)
          const offset = params.offset
          if (wanted === undefined) {
            return listResult(blocklist.records.map(compactBlocklistItem), {
              total: blocklist.total,
              offset,
            })
          }
          return {
            ...listResult(
              blocklist.records
                .filter((item) => item[arr.itemKey] === wanted)
                .map(compactBlocklistItem),
              { offset },
            ),
            ...(blocklist.total > blocklist.records.length
              ? {
                  scanned: `newest ${blocklist.records.length} of ${blocklist.total} entries`,
                }
              : {}),
          }
        }),
    }),
    quality_profiles: resource({
      description:
        "List quality profile IDs and names, or pass profileId for one profile's cutoff, allowed qualities, and nonzero custom-format scores",
      params: Type.Object({
        profileId: Type.Optional(Type.Integer({ minimum: 1 })),
        offset: offsetParam,
        formatScoreOffset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "With profileId only: use nextFormatScoreOffset to read more scores",
          }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          if (params.profileId !== undefined) {
            if (params.offset !== undefined)
              return yield* toolFail("offset applies to the profile list only")
            const profile = yield* arrObject(
              arr,
              `/api/v3/qualityprofile/${params.profileId}`,
              `quality profile ${params.profileId}`,
              signal,
            )
            return compactQualityProfile(profile, params.formatScoreOffset ?? 0)
          }
          if (params.formatScoreOffset !== undefined)
            return yield* toolFail("formatScoreOffset requires profileId")
          const profiles = yield* arrList(arr, "/api/v3/qualityprofile", {
            signal,
          })
          return listResult(
            profiles.map((profile) => pick(profile, ["id", "name"])),
            { offset: params.offset },
          )
        }),
    }),
    manual_import_candidates: resource({
      description:
        "Files the Arr could import from a folder or download, with its mapping and rejections. " +
        "rejections null is a candidate the Arr sent no rejection list for: unknown, not accepted",
      params: Type.Object(manualImportScope()),
      run: (params, signal) =>
        readCandidates(arr, params, signal).pipe(
          Effect.map((candidates) =>
            listResult(candidates.map(compactCandidate)),
          ),
        ),
    }),
    command_status: resource({
      description: "Status of one command, such as a search or manual import",
      params: Type.Object({ commandId: Type.Integer({ minimum: 1 }) }),
      run: (params, signal) =>
        arrObject(
          arr,
          `/api/v3/command/${params.commandId}`,
          `command ${params.commandId}`,
          signal,
        ).pipe(Effect.map(compactCommand)),
    }),
    health: resource({
      description:
        "The Arr's own health checks, each with its source, level, and message. An empty list is no reported problem, not proof that every dependency works",
      params: Type.Object({}),
      run: (_params, signal) =>
        readHealth(arr, { signal }).pipe(
          Effect.flatMap((checks) => toolCheck(() => listResult(checks))),
        ),
    }),
    disk_space: resource({
      description:
        "Free and total bytes of every disk the Arr sees, by the path it sees it at. A null size is one the Arr did not report",
      params: Type.Object({}),
      run: (_params, signal) =>
        arrList(arr, "/api/v3/diskspace", { signal }).pipe(
          Effect.flatMap((disks) =>
            toolCheck(() =>
              listResult(
                disks.map((disk) =>
                  scalars(diagnosticRecord(arr, "disk", disk, ["path"]), [
                    "path",
                    "label",
                    "freeSpace",
                    "totalSpace",
                  ]),
                ),
              ),
            ),
          ),
        ),
    }),
    download_clients: resource({
      description:
        "Download clients with protocol, enabled state, host, and the category and directory this Arr hands them, " +
        "plus remote path mappings and whether completed and failed downloads are handled automatically. No credentials. A null setting is one the client does not report. " +
        "The two lists share one result and each says where it was cut",
      params: Type.Object({
        clientOffset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Skip this many clients; clients.nextClientOffset",
          }),
        ),
        mappingOffset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Skip this many mappings; remotePathMappings.nextMappingOffset",
          }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const clients = yield* component(
            arr,
            "download clients",
            arrList(arr, "/api/v3/downloadclient", { signal }),
          )
          const mappings = yield* component(
            arr,
            "remote path mappings",
            arrList(arr, "/api/v3/remotepathmapping", { signal }),
          )
          const handling = yield* component(
            arr,
            "download handling settings",
            readDownloadHandling(arr, signal),
          )
          return yield* toolCheck(() =>
            downloadClientsResult(arr, { clients, mappings, handling }, params),
          )
        }),
    }),
  }
}
