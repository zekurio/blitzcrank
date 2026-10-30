import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../../config.ts"
import { isString } from "../../json.ts"
import { toolFail } from "../../tools/errors.ts"
import { action } from "../../tools/writes.ts"
import { readCategories, sabCall } from "./client.ts"
import { jobTarget, requireJob, verifyJob } from "./jobs.ts"

/** SABnzbd's numeric job priorities, by the name its queue reports. */
const PRIORITIES = { low: -1, normal: 0, high: 1, force: 2 } as const

const nzoIdParam = Type.String({
  minLength: 1,
  description: "The job's nzo_id, from sabnzbd_queue or sabnzbd_history",
})

export function sabnzbdActions(cfg: ServiceConfig) {
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
          const [state, categories] = yield* Effect.all(
            [
              requireJob(cfg, "queue", params.nzoId, signal),
              readCategories(cfg, signal),
            ],
            { concurrency: "unbounded" },
          )
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
