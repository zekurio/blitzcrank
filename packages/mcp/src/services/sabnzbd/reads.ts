import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../../config.ts"
import {
  isJsonObject,
  isNumber,
  objectField,
  objectList,
  pick,
} from "../../json.ts"
import { resource } from "../../tools/reads.ts"
import { listResult, MAX_LIST_ITEMS } from "../../tools/results.ts"
import { readCategories, sabCall } from "./client.ts"
import {
  compactHistorySlot,
  compactQueueSlot,
  DEFAULT_LIMIT,
  listQuery,
} from "./jobs.ts"

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

export function sabnzbdReads(cfg: ServiceConfig) {
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
