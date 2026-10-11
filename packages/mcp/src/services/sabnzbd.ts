import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import { jsonRequestEffect, type JsonValue } from "../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  objectField,
  objectList,
  pick,
  stringList,
  type JsonObject,
} from "../json.ts"
import {
  action,
  defineReads,
  defineWrites,
  listResult,
  MAX_LIST_ITEMS,
  resource,
  toolFail,
  type Resolved,
  type ServerTool,
  type ToolFailure,
  type WriteEffect,
} from "../tools.ts"

type Signal = AbortSignal | undefined
type JobList = "queue" | "history"
type SabParams = Record<string, string | number | undefined>

const DEFAULT_LIMIT = 20
const MAX_STAGE_CHARS = 300

/** SABnzbd's numeric job priorities, by the name its queue reports. */
const PRIORITIES = { low: -1, normal: 0, high: 1, force: 2 } as const

export function buildSabnzbdTools(cfg: ServiceConfig): ServerTool[] {
  const service = { name: "sabnzbd", label: "SABnzbd (downloads)" }
  return [
    ...defineReads(service, sabnzbdReads(cfg)),
    ...defineWrites(service, sabnzbdActions(cfg)),
  ]
}

/**
 * Every SABnzbd call is `GET /api?mode=...`; the mode decides whether it
 * reads or writes. The key travels in the query string, so the HTTP helper
 * redacts it from any error. An API-level failure answers HTTP 200 with
 * `status: false`.
 */
function sabCall(
  cfg: ServiceConfig,
  params: SabParams,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return jsonRequestEffect<JsonValue | undefined>(cfg.url, "/api", {
    query: { ...params, apikey: cfg.apiKey, output: "json" },
    signal,
  }).pipe(
    Effect.flatMap((response) => {
      if (!isJsonObject(response)) {
        return toolFail(
          `sabnzbd returned no JSON object for mode ${params.mode}`,
        )
      }
      if (response.status === false) {
        return toolFail(
          `sabnzbd refused mode ${params.mode}: ${String(response.error ?? "no reason given")}`,
        )
      }
      return Effect.succeed(response)
    }),
  )
}

const listParams = {
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIST_ITEMS,
      description: `Jobs to list (default ${DEFAULT_LIMIT})`,
    }),
  ),
  start: Type.Optional(Type.Integer({ minimum: 0 })),
  search: Type.Optional(
    Type.String({ minLength: 1, description: "Filter by job name" }),
  ),
  category: Type.Optional(Type.String({ minLength: 1 })),
  nzoIds: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "Only these jobs; an Arr downloadId is the job's nzo_id",
    }),
  ),
}

interface ListParams {
  limit?: number | undefined
  start?: number | undefined
  search?: string | undefined
  category?: string | undefined
  nzoIds?: string[] | undefined
}

function listQuery(mode: JobList, params: ListParams): SabParams {
  return {
    mode,
    limit: params.limit ?? DEFAULT_LIMIT,
    start: params.start,
    search: params.search,
    cat: params.category,
    nzo_ids: params.nzoIds?.join(","),
  }
}

function sabnzbdReads(cfg: ServiceConfig) {
  return {
    queue: resource({
      description:
        "Active downloads with progress, plus global pause and free disk space",
      params: Type.Object(listParams),
      run: (params, signal) =>
        sabCall(cfg, listQuery("queue", params), signal).pipe(
          Effect.map((response) => {
            const queue = objectField(response, "queue")
            const slots = objectList(queue?.slots)
            return {
              ...pick(queue, [
                "paused",
                "status",
                "speed",
                "timeleft",
                "mb",
                "mbleft",
                "diskspace1",
                "diskspace2",
              ]),
              ...listResult(slots.map(compactQueueSlot), {
                total: isNumber(queue?.noofslots)
                  ? queue.noofslots
                  : slots.length,
              }),
            }
          }),
        ),
    }),
    history: resource({
      description:
        "Finished and failed jobs with fail message, post-processing stages, and storage path",
      params: Type.Object({
        ...listParams,
        failedOnly: Type.Optional(Type.Boolean()),
      }),
      run: (params, signal) =>
        sabCall(
          cfg,
          {
            ...listQuery("history", params),
            failed_only: params.failedOnly === true ? 1 : undefined,
          },
          signal,
        ).pipe(
          Effect.map((response) => {
            const history = objectField(response, "history")
            const slots = objectList(history?.slots)
            return listResult(slots.map(compactHistorySlot), {
              total: isNumber(history?.noofslots)
                ? history.noofslots
                : slots.length,
            })
          }),
        ),
    }),
    version: resource({
      description: "SABnzbd version",
      params: Type.Object({}),
      run: (_params, signal) =>
        sabCall(cfg, { mode: "version" }, signal).pipe(
          Effect.map((response) => pick(response, ["version"])),
        ),
    }),
    warnings: resource({
      description:
        "Server-level warnings and errors, such as a full disk or a failing news server",
      params: Type.Object({}),
      run: (_params, signal) =>
        sabCall(cfg, { mode: "warnings" }, signal).pipe(
          Effect.map((response) =>
            listResult(
              objectList(response.warnings).map((warning) =>
                pick(warning, ["type", "text", "time", "origin"]),
              ),
            ),
          ),
        ),
    }),
    server_stats: resource({
      description: "Download volume per news server and in total",
      params: Type.Object({}),
      run: (_params, signal) =>
        sabCall(cfg, { mode: "server_stats" }, signal).pipe(
          Effect.map((response) => {
            const servers = objectField(response, "servers") ?? {}
            return {
              ...pick(response, ["total", "month", "week", "day"]),
              // Per-day history is a map with one key per day served.
              servers: Object.fromEntries(
                Object.entries(servers).map(([name, stats]) => [
                  name,
                  pick(isJsonObject(stats) ? stats : undefined, [
                    "total",
                    "month",
                    "week",
                    "day",
                    "articles_tried",
                    "articles_success",
                  ]),
                ]),
              ),
            }
          }),
        ),
    }),
    categories: resource({
      description: "Configured categories; an Arr tracks only its own",
      params: Type.Object({}),
      run: (_params, signal) =>
        readCategories(cfg, signal).pipe(
          Effect.map((categories) => ({ categories })),
        ),
    }),
  }
}

function readCategories(cfg: ServiceConfig, signal: Signal) {
  return sabCall(cfg, { mode: "get_cats" }, signal).pipe(
    Effect.map((response) => stringList(response.categories)),
  )
}

function compactQueueSlot(slot: JsonObject): JsonObject {
  return {
    nzo_id: slot.nzo_id ?? null,
    name: slot.filename ?? null,
    status: slot.status ?? null,
    category: slot.cat ?? null,
    ...pick(slot, ["priority", "percentage", "mb", "mbleft", "timeleft"]),
  }
}

function compactHistorySlot(slot: JsonObject): JsonObject {
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

function requireJob(
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

function jobTarget(
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
function verifyJob(
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

const nzoIdParam = Type.String({
  minLength: 1,
  description: "The job's nzo_id, from sabnzbd_queue or sabnzbd_history",
})

function sabnzbdActions(cfg: ServiceConfig) {
  return {
    retry_job: action({
      description: "Retry one failed job from history",
      params: Type.Object({ nzoId: nzoIdParam }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const state = yield* requireJob(cfg, "history", params.nzoId, signal)
          if (state.job.status !== "Failed") {
            return yield* toolFail(
              `only a failed job can be retried; ${params.nzoId} is ${String(state.job.status)}`,
            )
          }
          return jobTarget(state, params.nzoId, "retry", "Retry failed job", [
            "a retry cannot repair missing articles or a broken archive",
          ])
        }),
      write: (params) =>
        sabCall(cfg, { mode: "retry", value: params.nzoId }, undefined),
      verify: (params) =>
        verifyJob(
          cfg,
          "history",
          params.nzoId,
          (job) => job === undefined || job.status !== "Failed",
          "the job left the failed history; it is back in the queue",
        ),
    }),
    pause_job: action({
      description: "Pause one queued job",
      params: Type.Object({ nzoId: nzoIdParam }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const state = yield* requireJob(cfg, "queue", params.nzoId, signal)
          if (state.job.status === "Paused") {
            return yield* toolFail(`job ${params.nzoId} is already paused`)
          }
          return jobTarget(state, params.nzoId, "pause", "Pause job")
        }),
      write: (params) =>
        sabCall(
          cfg,
          { mode: "queue", name: "pause", value: params.nzoId },
          undefined,
        ),
      verify: (params) =>
        verifyJob(
          cfg,
          "queue",
          params.nzoId,
          (job) => job?.status === "Paused",
          "the job is paused",
        ),
    }),
    resume_job: action({
      description: "Resume one paused job",
      params: Type.Object({ nzoId: nzoIdParam }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const state = yield* requireJob(cfg, "queue", params.nzoId, signal)
          if (state.job.status !== "Paused") {
            return yield* toolFail(
              `job ${params.nzoId} is not paused (status ${String(state.job.status)}); a global pause is not a job pause`,
            )
          }
          return jobTarget(state, params.nzoId, "resume", "Resume job")
        }),
      write: (params) =>
        sabCall(
          cfg,
          { mode: "queue", name: "resume", value: params.nzoId },
          undefined,
        ),
      verify: (params) =>
        verifyJob(
          cfg,
          "queue",
          params.nzoId,
          (job) => job !== undefined && job.status !== "Paused",
          "the job is no longer paused",
        ),
    }),
    set_priority: action({
      description: "Change one queued job's priority",
      params: Type.Object({
        nzoId: nzoIdParam,
        priority: Type.Enum(["low", "normal", "high", "force"], {
          description: "force downloads even while the queue is paused",
        }),
      }),
      resolve: (params, signal) =>
        requireJob(cfg, "queue", params.nzoId, signal).pipe(
          Effect.map((state) =>
            jobTarget(
              state,
              params.nzoId,
              "priority",
              `Set priority ${String(state.job.priority ?? "unknown")} -> ${params.priority}`,
              params.priority === "force"
                ? ["a forced job ignores the global pause"]
                : [],
            ),
          ),
        ),
      write: (params) =>
        sabCall(
          cfg,
          {
            mode: "queue",
            name: "priority",
            value: params.nzoId,
            value2: PRIORITIES[params.priority],
          },
          undefined,
        ),
      verify: (params) =>
        verifyJob(
          cfg,
          "queue",
          params.nzoId,
          (job) =>
            isString(job?.priority) &&
            job.priority.toLowerCase() === params.priority,
          `the job has priority ${params.priority}`,
        ),
    }),
    change_category: action({
      description: "Move one queued job to another category",
      params: Type.Object({
        nzoId: nzoIdParam,
        category: Type.String({
          minLength: 1,
          description: "A category from sabnzbd_categories",
        }),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const state = yield* requireJob(cfg, "queue", params.nzoId, signal)
          const categories = yield* readCategories(cfg, signal)
          if (!categories.includes(params.category)) {
            return yield* toolFail(
              `sabnzbd has no category ${params.category}; it has ${categories.join(", ")}`,
            )
          }
          if (state.job.cat === params.category) {
            return yield* toolFail(
              `job ${params.nzoId} is already in category ${params.category}`,
            )
          }
          return jobTarget(
            state,
            params.nzoId,
            "category",
            `Move category ${String(state.job.cat ?? "none")} -> ${params.category}`,
            [
              "an Arr tracks only jobs in its own category and loses sight of a job moved out of it",
            ],
          )
        }),
      write: (params) =>
        sabCall(
          cfg,
          { mode: "change_cat", value: params.nzoId, value2: params.category },
          undefined,
        ),
      verify: (params) =>
        verifyJob(
          cfg,
          "queue",
          params.nzoId,
          (job) => job?.cat === params.category,
          `the job is in category ${params.category}`,
        ),
    }),
    delete_job: action({
      description: "Remove one job from the queue or from history",
      params: Type.Object({
        nzoId: nzoIdParam,
        from: Type.Enum(["queue", "history"]),
        deleteFiles: Type.Boolean({
          description: "Also delete the downloaded data from disk",
        }),
      }),
      resolve: (params, signal) =>
        requireJob(cfg, params.from, params.nzoId, signal).pipe(
          Effect.map((state) =>
            jobTarget(
              state,
              params.nzoId,
              "delete",
              `Delete job from the ${params.from}${params.deleteFiles ? " with its downloaded data" : ""}`,
              [
                ...(params.deleteFiles
                  ? ["the downloaded data is deleted and cannot be recovered"]
                  : []),
                "an Arr that still waits on this job is left without it",
              ],
            ),
          ),
        ),
      write: (params) =>
        sabCall(
          cfg,
          {
            mode: params.from,
            name: "delete",
            value: params.nzoId,
            del_files: params.deleteFiles ? 1 : 0,
          },
          undefined,
        ),
      verify: (params) =>
        verifyJob(
          cfg,
          params.from,
          params.nzoId,
          (job) => job === undefined,
          `the job is gone from the ${params.from}`,
        ),
    }),
  }
}
