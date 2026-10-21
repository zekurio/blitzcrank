import { Effect } from "effect"

import type { ServiceConfig } from "../../config.ts"
import type { JsonValue, Signal } from "../../http.ts"
import {
  isNumber,
  isString,
  objectField,
  objectList,
  pick,
  stringList,
  type JsonObject,
} from "../../json.ts"
import { toolFail, type ToolFailure } from "../../tools/errors.ts"
import type { Resolved, WriteEffect } from "../../tools/writes.ts"
import { sabCall, type SabParams } from "./client.ts"

type JobList = "queue" | "history"

export const DEFAULT_LIMIT = 20
const MAX_STAGE_CHARS = 300

interface ListParams {
  limit?: number | undefined
  start?: number | undefined
  search?: string | undefined
  category?: string | undefined
  nzoIds?: string[] | undefined
}

export function listQuery(mode: JobList, params: ListParams): SabParams {
  return {
    mode,
    limit: params.limit ?? DEFAULT_LIMIT,
    start: params.start,
    search: params.search,
    cat: params.category,
    nzo_ids: params.nzoIds?.join(","),
  }
}

export function compactQueueSlot(slot: JsonObject): JsonObject {
  return {
    nzo_id: slot.nzo_id ?? null,
    name: slot.filename ?? null,
    status: slot.status ?? null,
    category: slot.cat ?? null,
    ...pick(slot, ["priority", "percentage", "mb", "mbleft", "timeleft"]),
  }
}

export function compactHistorySlot(slot: JsonObject): JsonObject {
  return {
    ...pick(slot, [
      "nzo_id",
      "name",
      "status",
      "category",
      "fail_message",
      "storage",
      "bytes",
    ]),
    completed: isNumber(slot.completed)
      ? new Date(slot.completed * 1000).toISOString()
      : null,
    stages: objectList(slot.stage_log).map((stage) => ({
      name: stage.name ?? null,
      // The last line is the stage's verdict. Lines carry HTML.
      last: (stringList(stage.actions).at(-1) ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_STAGE_CHARS),
    })),
  }
}

function compactSlot(list: JobList, slot: JsonObject): JsonObject {
  return list === "queue" ? compactQueueSlot(slot) : compactHistorySlot(slot)
}

interface JobState {
  list: JobList
  job: JsonObject
}

/** `undefined` when the job is not in that list. */
function findJob(
  cfg: ServiceConfig,
  list: JobList,
  nzoId: string,
  signal: Signal,
): Effect.Effect<JsonObject | undefined, ToolFailure> {
  return sabCall(cfg, { mode: list, nzo_ids: nzoId, limit: 500 }, signal).pipe(
    Effect.map((response) =>
      // Old versions ignore `nzo_ids` and answer with the whole list.
      objectList(objectField(response, list)?.slots).find(
        (slot) => slot.nzo_id === nzoId,
      ),
    ),
  )
}

export function requireJob(
  cfg: ServiceConfig,
  list: JobList,
  nzoId: string,
  signal: Signal,
): Effect.Effect<JobState, ToolFailure> {
  return findJob(cfg, list, nzoId, signal).pipe(
    Effect.flatMap((job) =>
      job
        ? Effect.succeed({ list, job })
        : toolFail(`the sabnzbd ${list} has no job ${nzoId}`),
    ),
  )
}

function jobName(state: JobState): string {
  return String(state.job.filename ?? state.job.name ?? "unnamed job")
}

/** Title, category, status, and storage path: what identifies the job. */
function jobDetail(state: JobState): string {
  const job = state.job
  return [
    `in the ${state.list}`,
    `category ${String(job.cat ?? job.category ?? "none")}`,
    `status ${String(job.status ?? "unknown")}`,
    ...(isString(job.storage) && job.storage !== ""
      ? [`storage ${job.storage}`]
      : []),
    ...(isString(job.fail_message) && job.fail_message !== ""
      ? [`failed with: ${job.fail_message.slice(0, MAX_STAGE_CHARS)}`]
      : []),
  ].join("; ")
}

export function jobTarget(
  state: JobState,
  nzoId: string,
  kind: string,
  summary: string,
  warnings: string[] = [],
): Resolved<JobState> {
  const effect: WriteEffect = {
    kind,
    target: `${jobName(state)} (${nzoId})`,
    detail: jobDetail(state),
  }
  return {
    state,
    summary: `${summary}: ${jobName(state)}`,
    effects: [effect],
    warnings,
  }
}

/** Re-reads the list a job action worked on and judges the expected state. */
export function verifyJob(
  cfg: ServiceConfig,
  list: JobList,
  nzoId: string,
  expected: (job: JsonObject | undefined) => boolean,
  confirmed: string,
): Effect.Effect<JsonValue, ToolFailure> {
  return findJob(cfg, list, nzoId, undefined).pipe(
    Effect.map((job): JsonValue => {
      const seen = job ? compactSlot(list, job) : null
      return expected(job)
        ? { confirmed, job: seen }
        : {
            warning: `the ${list} does not show the expected state yet; read it again`,
            job: seen,
          }
    }),
  )
}
