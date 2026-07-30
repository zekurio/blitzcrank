import { StringEnum } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.js"
import { jsonRequest, HttpError } from "../services/http.js"
import {
  makeReadTool,
  reasonParam,
  runMutation,
  textResult,
  type EvidenceRequirement,
  type ServiceName,
} from "./common.js"
import type { RunContext } from "./context.js"

/**
 * Sonarr/Radarr tools. Mutation surface mirrors the legacy allowlist exactly:
 *  sonarr: EpisodeSearch/SeasonSearch/SeriesSearch/RefreshSeries commands,
 *          queue grab/delete, blocklist add/delete, episodefile delete
 *  radarr: MoviesSearch/RefreshMovie commands, queue grab/delete,
 *          blocklist add/delete, moviefile delete
 *
 * Note: moviefile deletion was absent from the legacy allowlist (never
 * documented as an incident response); added deliberately — the evidence
 * gates apply.
 *
 * Blocklisting a past grab was also absent, and its absence had teeth: the
 * only way to blocklist anything was to delete a *live* queue item, so a
 * replacement search fired against a known-bad release had to re-grab it
 * before it could be excluded. See `blocklist_from_history`.
 */

function arrRequest(
  cfg: ServiceConfig,
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
) {
  return jsonRequest(cfg.url, path, {
    method,
    headers: { "X-Api-Key": cfg.apiKey },
    ...(body !== undefined ? { body } : {}),
  })
}

/**
 * One episode as far as search scope is concerned.
 */
export interface ScopedEpisode {
  id: number
  seasonNumber: number
  monitored: boolean
  filePath: string | undefined
}

/**
 * Scope gate for Sonarr searches.
 *
 * A `SeasonSearch` is one tool call that re-grabs an entire season: in the
 * incident this gate comes from, an unverified hypothesis about a missing
 * audio track cost 24 downloads, ~21 GB, and 18 encodes. Two things are
 * therefore enforced before any multi-episode search:
 *
 *  - the model must state the true number of affected episodes
 *    (`expectedEpisodeCount`), which it can only get right by reading them, so
 *    the real scope is surfaced before execution rather than after;
 *  - replacing files that already exist needs *file-level* evidence: at least
 *    one of them must have been probed with `media_probe` this run, because
 *    Arr `languages`/quality metadata is parsed from the release name.
 *
 * Missing media is unaffected: searching for episodes that have no file is
 * the normal remediation path and needs no probe.
 */
export function assertSearchScope(input: {
  episodes: ScopedEpisode[]
  expectedEpisodeCount: number | undefined
  probeAvailable: boolean
  probed: (filePath: string) => boolean
}): void {
  if (input.episodes.length === 0) {
    throw new Error(
      "scope gate: this search matches no monitored episode; nothing would be " +
        "searched. Check monitoring and the season number before acting.",
    )
  }
  if (
    input.episodes.length > 1 &&
    input.expectedEpisodeCount !== input.episodes.length
  ) {
    const replaced = input.episodes.filter((e) => e.filePath !== undefined)
    throw new Error(
      `scope gate: this search affects ${input.episodes.length} episodes ` +
        `(${replaced.length} already have a file and would be replaced). ` +
        `Pass expectedEpisodeCount: ${input.episodes.length} to confirm you intend that ` +
        "scope and have told the reporter the real number, or search a single episode " +
        "first with episodeIds to test the hypothesis at 1/N the cost.",
    )
  }
  const replacements = input.episodes.filter(
    (episode): episode is ScopedEpisode & { filePath: string } =>
      episode.filePath !== undefined,
  )
  if (replacements.length < 2 || !input.probeAvailable) return
  if (replacements.some((episode) => input.probed(episode.filePath))) return
  throw new Error(
    `evidence gate: this search would replace ${replacements.length} existing episode ` +
      "files, so it needs file-level evidence. Sonarr `languages`, `quality`, and custom " +
      "formats are parsed from the release name and never prove what a file contains: " +
      `probe at least one of the affected files with media_probe first (e.g. ${replacements[0]!.filePath}). ` +
      "If the probe shows the file already lacks the track, a re-grab of the same release cannot add it.",
  )
}

interface SonarrEpisodeRecord {
  id?: number
  seasonNumber?: number
  monitored?: boolean
  hasFile?: boolean
  episodeFile?: { path?: string }
}

/**
 * The episodes a search would actually touch.
 *
 * This is an internal guard read and is deliberately *not* fed to
 * `ctx.recordRead`: the response contains every episode id of the series, so
 * recording it would let a guessed id pass the ID evidence gate.
 */
async function scopedEpisodes(
  cfg: ServiceConfig,
  params: {
    seriesId: number
    seasonNumber?: number | undefined
    episodeIds?: number[] | undefined
  },
): Promise<ScopedEpisode[]> {
  const raw = await arrRequest(
    cfg,
    `/api/v3/episode?seriesId=${params.seriesId}&includeEpisodeFile=true`,
  )
  if (!Array.isArray(raw)) {
    throw new Error(
      `could not read the episodes of series ${params.seriesId}; refusing to search with unknown scope`,
    )
  }
  const episodes = (raw as SonarrEpisodeRecord[]).flatMap<ScopedEpisode>(
    (episode) =>
      typeof episode.id === "number"
        ? [
            {
              id: episode.id,
              seasonNumber:
                typeof episode.seasonNumber === "number"
                  ? episode.seasonNumber
                  : -1,
              monitored: episode.monitored === true,
              filePath:
                episode.hasFile === true
                  ? episode.episodeFile?.path
                  : undefined,
            },
          ]
        : [],
  )

  if (params.episodeIds && params.episodeIds.length > 0) {
    const byId = new Map(episodes.map((episode) => [episode.id, episode]))
    return [...new Set(params.episodeIds)].map((id) => {
      const episode = byId.get(id)
      if (!episode) {
        throw new Error(
          `episode id ${id} does not belong to series ${params.seriesId}; fetch the episodes again`,
        )
      }
      return episode
    })
  }
  // Sonarr only searches monitored episodes, so they are the real scope.
  const monitored = episodes.filter((episode) => episode.monitored)
  if (params.seasonNumber === undefined) return monitored
  return monitored.filter(
    (episode) => episode.seasonNumber === params.seasonNumber,
  )
}

/** Follow-up read on the queued command so the model can see it was accepted. */
async function verifyCommand(
  cfg: ServiceConfig,
  service: ServiceName,
  ctx: RunContext,
  result: unknown,
) {
  const id = (result as { id?: number } | null)?.id
  if (!id)
    return {
      warning:
        "command response had no id; verify manually via GET /api/v3/command",
    }
  const status = await arrRequest(cfg, `/api/v3/command/${id}`)
  ctx.recordRead(service, `/api/v3/command/${id}`, JSON.stringify(status))
  return status
}

async function verifyQueue(
  cfg: ServiceConfig,
  service: ServiceName,
  ctx: RunContext,
) {
  const queue = await arrRequest(cfg, `/api/v3/queue?pageSize=100`)
  ctx.recordRead(service, `/api/v3/queue?pageSize=100`, JSON.stringify(queue))
  return queue
}

/**
 * Newest blocklist entries plus the queue: marking a grab failed blocklists the
 * release *and*, with the Arr's default `autoRedownloadFailed`, makes it search
 * for a replacement on its own. Both halves have to be visible, or the model
 * cannot tell an exclusion that worked from one that immediately re-grabbed.
 */
async function verifyBlocklistAndQueue(
  cfg: ServiceConfig,
  service: ServiceName,
  ctx: RunContext,
) {
  const path = `/api/v3/blocklist?page=1&pageSize=20&sortKey=date&sortDirection=descending`
  const blocklist = await arrRequest(cfg, path)
  ctx.recordRead(service, path, JSON.stringify(blocklist))
  return { blocklist, queue: await verifyQueue(cfg, service, ctx) }
}

/**
 * ManualImport command tool shared by both Arrs. `files` are candidate objects
 * the model takes from GET /api/v3/manualimport; every path and id in them is
 * evidence-gated so candidates cannot be invented.
 */
function manualImportTool(
  service: ServiceName,
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition {
  return defineTool({
    name: `${service}_manual_import`,
    label: `${service}: manual import`,
    description:
      `Run ${service}'s ManualImport command for verified candidates from a GET /api/v3/manualimport read this run. ` +
      "Trim each candidate to the fields the command needs " +
      (service === "sonarr"
        ? "(path, folderName, seriesId, episodeIds, quality, languages, releaseGroup); use importMode move."
        : "(path, folderName, movieId, quality, languages, releaseGroup); use importMode auto."),
    parameters: Type.Object({
      reason: reasonParam(),
      files: Type.Array(Type.Record(Type.String(), Type.Any()), {
        minItems: 1,
        description:
          "Candidate objects from the manualimport read, trimmed to required fields",
      }),
      importMode: StringEnum(["auto", "move", "copy"] as const),
    }),
    async execute(_toolCallId, params) {
      const evidence: EvidenceRequirement[] = params.files.flatMap((file) => {
        const path = file.path
        if (typeof path !== "string" || path.length === 0) {
          throw new Error(
            "every manual import file needs the candidate's path field",
          )
        }
        const ids = [
          file.seriesId,
          file.movieId,
          ...(Array.isArray(file.episodeIds) ? file.episodeIds : []),
        ].filter((id): id is number => typeof id === "number")
        return [
          { service, value: path, hint: "candidate path" },
          ...ids.map((id) => ({
            service,
            value: id,
            hint: "candidate target id",
          })),
        ]
      })
      const outcome = await runMutation(ctx, {
        kind: "mutate",
        evidence,
        perform: () =>
          arrRequest(cfg, "/api/v3/command", "POST", {
            name: "ManualImport",
            files: params.files,
            importMode: params.importMode,
          }),
        verify: (result) => verifyCommand(cfg, service, ctx, result),
      })
      return textResult(outcome, {
        service,
        action: "manual_import",
        files: params.files.length,
      })
    },
  })
}

function queueAndBlocklistTools(
  service: ServiceName,
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition[] {
  return [
    defineTool({
      name: `${service}_delete_queue_item`,
      label: `${service}: remove queue item`,
      description: `Remove a stuck/failed download from the ${service} queue, optionally blocklisting the release and removing it from the download client. With removeFromClient=true the downloaded data is destroyed and the call is recorded as a deletion. The queue item id must come from a queue read on this issue.`,
      parameters: Type.Object({
        reason: reasonParam(),
        queueId: Type.Integer({ minimum: 1 }),
        blocklist: Type.Boolean({
          description:
            "Blocklist the release so it is not grabbed again (default true)",
        }),
        removeFromClient: Type.Boolean({
          description:
            "Also remove the job from the download client, destroying the downloaded data (default true)",
        }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          // Discarding a finished download is the same class of act as deleting
          // the imported file: bytes someone waited for stop existing. Counting
          // it as a plain mutation would leave it entirely uncapped now that
          // only deletions are budgeted.
          kind: params.removeFromClient ? "delete" : "mutate",
          evidence: [{ service, value: params.queueId, hint: "queue item id" }],
          perform: () =>
            arrRequest(
              cfg,
              `/api/v3/queue/${params.queueId}?removeFromClient=${params.removeFromClient}&blocklist=${params.blocklist}`,
              "DELETE",
            ),
          verify: () => verifyQueue(cfg, service, ctx),
        })
        return textResult(outcome, {
          service,
          action: "delete_queue_item",
          queueId: params.queueId,
        })
      },
    }),
    defineTool({
      name: `${service}_blocklist_from_history`,
      label: `${service}: blocklist a past grab`,
      description:
        `Blocklist the release behind one ${service} history record, so it is never grabbed again. Marks that grab as failed ` +
        `(POST /api/v3/history/failed/{id}), which is the only way to exclude a release that has left the queue. Use this on ` +
        `the bad release when replacing a wrong or corrupt file: unblocked, it usually still scores highest and a plain ` +
        `search just grabs it again. Two consequences to plan for: with the Arr's default autoRedownloadFailed it also ` +
        `starts its own replacement search, so do not follow it with a separate search call — read the queue instead and ` +
        `check which release it picked; and if that grab is still active in the download client it will be discarded, so ` +
        `point this at a grab that is finished, not at the download you are waiting on. The history record id must come ` +
        `from a ${service} history read this run.`,
      parameters: Type.Object({
        reason: reasonParam(),
        historyId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [
            { service, value: params.historyId, hint: "history record id" },
          ],
          perform: () =>
            arrRequest(
              cfg,
              `/api/v3/history/failed/${params.historyId}`,
              "POST",
            ),
          verify: () => verifyBlocklistAndQueue(cfg, service, ctx),
        })
        return textResult(outcome, {
          service,
          action: "blocklist_from_history",
          historyId: params.historyId,
        })
      },
    }),
    defineTool({
      name: `${service}_grab_queue_item`,
      label: `${service}: force-grab queue item`,
      description: `Force ${service} to grab a pending/delayed queue item now. The queue item id must come from a queue read this run.`,
      parameters: Type.Object({
        reason: reasonParam(),
        queueId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service, value: params.queueId, hint: "queue item id" }],
          perform: () =>
            arrRequest(cfg, `/api/v3/queue/grab/${params.queueId}`, "POST"),
          verify: () => verifyQueue(cfg, service, ctx),
        })
        return textResult(outcome, {
          service,
          action: "grab_queue_item",
          queueId: params.queueId,
        })
      },
    }),
    defineTool({
      name: `${service}_remove_from_blocklist`,
      label: `${service}: remove blocklist entry`,
      description: `Remove one entry from the ${service} blocklist so that release can be grabbed again. The blocklist entry id must come from a blocklist read this run.`,
      parameters: Type.Object({
        reason: reasonParam(),
        blocklistId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [
            { service, value: params.blocklistId, hint: "blocklist entry id" },
          ],
          perform: () =>
            arrRequest(
              cfg,
              `/api/v3/blocklist/${params.blocklistId}`,
              "DELETE",
            ),
        })
        return textResult(outcome, {
          service,
          action: "remove_from_blocklist",
          blocklistId: params.blocklistId,
        })
      },
    }),
  ]
}

export function buildSonarrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
  /** Whether media_probe exists this run; the file-evidence gate needs it. */
  probeAvailable: boolean,
): ToolDefinition[] {
  const service: ServiceName = "sonarr"
  return [
    makeReadTool(
      {
        service,
        label: "Sonarr read",
        description:
          "Read Sonarr (TV) state via /api/v3 paths: series, episode, episodefile, queue, history, blocklist, wanted/missing.",
        request: (path) => arrRequest(cfg, path),
      },
      ctx,
    ),
    defineTool({
      name: "sonarr_search",
      label: "Sonarr: trigger search",
      description:
        "Trigger a Sonarr search: whole series, one season, or specific episodes. The series id (and episode ids, if given) must come from Sonarr reads this run. " +
        "Scope is enforced: a search affecting more than one episode must state the true episode count in expectedEpisodeCount, and replacing two or more existing " +
        "episode files additionally requires that one of them was inspected with media_probe this run. Prefer one episode first to test a hypothesis.",
      parameters: Type.Object({
        reason: reasonParam(),
        seriesId: Type.Integer({
          minimum: 1,
          description: "Internal Sonarr series id (not tvdbId)",
        }),
        seasonNumber: Type.Optional(Type.Integer({ minimum: 0 })),
        episodeIds: Type.Optional(
          Type.Array(Type.Integer({ minimum: 1 }), {
            description:
              "Internal Sonarr episode ids for a targeted EpisodeSearch",
          }),
        ),
        expectedEpisodeCount: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "How many episodes this search affects; required (and checked against Sonarr) when that is more than one",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        // Before spending a request on the scope read: a guessed series id must
        // fail the ID gate, not produce a confusing empty-scope error.
        ctx.requireEvidence(service, params.seriesId, "series id")
        const episodes = await scopedEpisodes(cfg, params)
        assertSearchScope({
          episodes,
          expectedEpisodeCount: params.expectedEpisodeCount,
          probeAvailable,
          probed: (filePath) => ctx.sawProbe(filePath),
        })
        const command =
          params.episodeIds && params.episodeIds.length > 0
            ? { name: "EpisodeSearch", episodeIds: params.episodeIds }
            : params.seasonNumber !== undefined
              ? {
                  name: "SeasonSearch",
                  seriesId: params.seriesId,
                  seasonNumber: params.seasonNumber,
                }
              : { name: "SeriesSearch", seriesId: params.seriesId }
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [
            { service, value: params.seriesId, hint: "series id" },
            ...(params.episodeIds ?? []).map((id) => ({
              service,
              value: id,
              hint: "episode id",
            })),
          ],
          perform: () => arrRequest(cfg, "/api/v3/command", "POST", command),
          verify: (result) => verifyCommand(cfg, service, ctx, result),
        })
        return textResult(outcome, {
          service,
          action: "search",
          command: command.name,
          episodes: episodes.length,
        })
      },
    }),
    defineTool({
      name: "sonarr_refresh_series",
      label: "Sonarr: refresh series",
      description:
        "Refresh a series' metadata and rescan its files (RefreshSeries). The series id must come from a Sonarr read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        seriesId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service, value: params.seriesId, hint: "series id" }],
          perform: () =>
            arrRequest(cfg, "/api/v3/command", "POST", {
              name: "RefreshSeries",
              seriesId: params.seriesId,
            }),
          verify: (result) => verifyCommand(cfg, service, ctx, result),
        })
        return textResult(outcome, {
          service,
          action: "refresh_series",
          seriesId: params.seriesId,
        })
      },
    }),
    defineTool({
      name: "sonarr_delete_episode_file",
      label: "Sonarr: delete episode file",
      description:
        "Delete one episode file from disk (e.g. verified corrupt), so a replacement can be searched. Call it once per file when a whole verified set is wrong. The episodefile id must come from a Sonarr read on this issue.",
      parameters: Type.Object({
        reason: reasonParam(),
        episodeFileId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "delete",
          evidence: [
            { service, value: params.episodeFileId, hint: "episodefile id" },
          ],
          perform: () =>
            arrRequest(
              cfg,
              `/api/v3/episodefile/${params.episodeFileId}`,
              "DELETE",
            ),
          verify: async () => {
            try {
              const still = await arrRequest(
                cfg,
                `/api/v3/episodefile/${params.episodeFileId}`,
              )
              return {
                warning: "episode file still present after delete",
                body: still,
              }
            } catch (err) {
              if (err instanceof HttpError && err.status === 404) {
                return {
                  confirmed: "episode file no longer present (HTTP 404)",
                }
              }
              throw err
            }
          },
        })
        return textResult(outcome, {
          service,
          action: "delete_episode_file",
          episodeFileId: params.episodeFileId,
        })
      },
    }),
    manualImportTool(service, cfg, ctx),
    ...queueAndBlocklistTools(service, cfg, ctx),
  ]
}

export function buildRadarrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition[] {
  const service: ServiceName = "radarr"
  return [
    makeReadTool(
      {
        service,
        label: "Radarr read",
        description:
          "Read Radarr (movies) state via /api/v3 paths: movie, moviefile, queue, history, blocklist.",
        request: (path) => arrRequest(cfg, path),
      },
      ctx,
    ),
    defineTool({
      name: "radarr_search",
      label: "Radarr: trigger movie search",
      description:
        "Trigger a Radarr search for one movie (MoviesSearch). The movie id must come from a Radarr read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        movieId: Type.Integer({
          minimum: 1,
          description: "Internal Radarr movie id (not tmdbId)",
        }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service, value: params.movieId, hint: "movie id" }],
          perform: () =>
            arrRequest(cfg, "/api/v3/command", "POST", {
              name: "MoviesSearch",
              movieIds: [params.movieId],
            }),
          verify: (result) => verifyCommand(cfg, service, ctx, result),
        })
        return textResult(outcome, {
          service,
          action: "search",
          movieId: params.movieId,
        })
      },
    }),
    defineTool({
      name: "radarr_delete_movie_file",
      label: "Radarr: delete movie file",
      description:
        "Delete one movie file from disk (e.g. verified corrupt), so a replacement can be searched. This removes the only copy of the movie — evidence must be strong. The moviefile id must come from a Radarr read on this issue.",
      parameters: Type.Object({
        reason: reasonParam(),
        movieFileId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "delete",
          evidence: [
            { service, value: params.movieFileId, hint: "moviefile id" },
          ],
          perform: () =>
            arrRequest(
              cfg,
              `/api/v3/moviefile/${params.movieFileId}`,
              "DELETE",
            ),
          verify: async () => {
            try {
              const still = await arrRequest(
                cfg,
                `/api/v3/moviefile/${params.movieFileId}`,
              )
              return {
                warning: "movie file still present after delete",
                body: still,
              }
            } catch (err) {
              if (err instanceof HttpError && err.status === 404) {
                return { confirmed: "movie file no longer present (HTTP 404)" }
              }
              throw err
            }
          },
        })
        return textResult(outcome, {
          service,
          action: "delete_movie_file",
          movieFileId: params.movieFileId,
        })
      },
    }),
    defineTool({
      name: "radarr_refresh_movie",
      label: "Radarr: refresh movie",
      description:
        "Refresh a movie's metadata and rescan its files (RefreshMovie). The movie id must come from a Radarr read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        movieId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service, value: params.movieId, hint: "movie id" }],
          perform: () =>
            arrRequest(cfg, "/api/v3/command", "POST", {
              name: "RefreshMovie",
              movieIds: [params.movieId],
            }),
          verify: (result) => verifyCommand(cfg, service, ctx, result),
        })
        return textResult(outcome, {
          service,
          action: "refresh_movie",
          movieId: params.movieId,
        })
      },
    }),
    manualImportTool(service, cfg, ctx),
    ...queueAndBlocklistTools(service, cfg, ctx),
  ]
}
