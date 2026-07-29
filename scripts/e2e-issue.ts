/** End-to-end harness: real model, mock Jellyseerr + Radarr, corrupt-movie scenario. */
import { serve } from "@hono/node-server"
import { Hono } from "hono"

// Costs real model tokens: run manually via `pnpm e2e:issue`.

process.env.SEERR_URL = "http://127.0.0.1:5056"
process.env.SEERR_API_KEY = "mock"
process.env.RADARR_URL = "http://127.0.0.1:7879"
process.env.RADARR_API_KEY = "mock"
process.env.BLITZCRANK_DATA_DIR = "tmp/e2e-data"
delete process.env.SONARR_URL
delete process.env.SABNZBD_URL
delete process.env.JELLYFIN_URL

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent")
const { IssueRunner } = await import("../src/agent/runner.js")
const { DEFAULT_MODEL } = await import("../src/agent/session.js")
const { loadConfig } = await import("../src/config.js")

const calls: string[] = []
let fileDeleted = false
let searchTriggered = false

const seerr = new Hono()
seerr.get("/api/v1/issue/9", (c) => {
  calls.push("seerr GET issue")
  return c.json({
    id: 9,
    issueType: 1,
    status: 1,
    problemSeason: 0,
    problemEpisode: 0,
    createdBy: { id: 5, displayName: "zekurio" },
    comments: [
      {
        id: 1,
        user: { displayName: "zekurio" },
        message:
          "Der Film ruckelt stark und ab Minute 20 ist das Bild komplett kaputt (Artefakte, Blöcke). Bitte neu laden.",
      },
    ],
    media: {
      id: 77,
      mediaType: "movie",
      tmdbId: 603,
      tvdbId: null,
      status: 5,
      imdbId: "tt0133093",
    },
  })
})
let nextCommentId = 1
seerr.post("/api/v1/issue/9/comment", async (c) => {
  const body = await c.req.json()
  calls.push(`seerr COMMENT: ${body.message}`)
  nextCommentId += 1
  return c.json({ id: 9, comments: [{ id: 1 }, { id: nextCommentId }] })
})
seerr.put("/api/v1/issueComment/:id", async (c) => {
  const body = await c.req.json()
  calls.push(`seerr EDIT COMMENT ${c.req.param("id")}: ${body.message}`)
  return c.json({ id: Number(c.req.param("id")) })
})
seerr.delete("/api/v1/issueComment/:id", (c) => {
  calls.push(`seerr DELETE COMMENT ${c.req.param("id")}`)
  return c.body(null, 204)
})
seerr.post("/api/v1/issue/9/:status", (c) => {
  calls.push(`seerr STATUS -> ${c.req.param("status")}`)
  return c.json({ id: 9 })
})

const radarr = new Hono()
radarr.get("/api/v3/movie", (c) => {
  calls.push(`radarr GET movie tmdbId=${c.req.query("tmdbId")}`)
  return c.json([
    {
      id: 42,
      title: "The Matrix",
      year: 1999,
      tmdbId: 603,
      hasFile: !fileDeleted,
      monitored: true,
      movieFileId: fileDeleted ? 0 : 7,
      qualityProfileId: 1,
      path: "/data/movies/The Matrix (1999)",
    },
  ])
})
radarr.get("/api/v3/movie/42", (c) =>
  c.json({
    id: 42,
    title: "The Matrix",
    year: 1999,
    tmdbId: 603,
    hasFile: !fileDeleted,
    movieFileId: fileDeleted ? 0 : 7,
  }),
)
radarr.get("/api/v3/moviefile", (c) => {
  calls.push("radarr GET moviefile list")
  return c.json(
    fileDeleted
      ? []
      : [
          {
            id: 7,
            movieId: 42,
            relativePath: "The.Matrix.1999.1080p.WEB.x264-GRP.mkv",
            path: "/data/movies/The Matrix (1999)/The.Matrix.1999.1080p.WEB.x264-GRP.mkv",
            size: 8123456789,
            quality: { quality: { name: "WEBDL-1080p" } },
            mediaInfo: {
              videoCodec: "x264",
              audioCodec: "AC3",
              runTime: "0:31:12",
              videoDynamicRange: "",
            },
            dateAdded: "2026-07-20T10:00:00Z",
          },
        ],
  )
})
radarr.get("/api/v3/moviefile/7", (c) => {
  calls.push(`radarr GET moviefile/7 (deleted=${fileDeleted})`)
  if (fileDeleted) return c.json({ message: "NotFound" }, 404)
  return c.json({
    id: 7,
    movieId: 42,
    path: "/data/movies/The Matrix (1999)/The.Matrix.1999.1080p.WEB.x264-GRP.mkv",
    size: 8123456789,
    mediaInfo: { videoCodec: "x264", runTime: "0:31:12" },
  })
})
radarr.delete("/api/v3/moviefile/7", (c) => {
  calls.push("radarr DELETE moviefile/7")
  fileDeleted = true
  return c.json({})
})
radarr.get("/api/v3/history/movie", (c) =>
  c.json([
    {
      movieId: 42,
      sourceTitle: "The.Matrix.1999.1080p.WEB.x264-GRP",
      eventType: "downloadFolderImported",
      date: "2026-07-20T10:00:00Z",
      data: { downloadClient: "sabnzbd" },
    },
  ]),
)
radarr.get("/api/v3/history", (c) =>
  c.json({
    page: 1,
    records: [
      {
        movieId: 42,
        sourceTitle: "The.Matrix.1999.1080p.WEB.x264-GRP",
        eventType: "downloadFolderImported",
        date: "2026-07-20T10:00:00Z",
      },
    ],
  }),
)
radarr.get("/api/v3/queue", (c) => {
  calls.push("radarr GET queue")
  return c.json({
    page: 1,
    totalRecords: searchTriggered ? 1 : 0,
    records: searchTriggered
      ? [
          {
            id: 501,
            movieId: 42,
            title: "The.Matrix.1999.1080p.BluRay.x265-BETTER",
            status: "downloading",
            timeleft: "00:12:00",
          },
        ]
      : [],
  })
})
radarr.post("/api/v3/command", async (c) => {
  const body = await c.req.json()
  calls.push(
    `radarr COMMAND ${body.name} ${JSON.stringify(body.movieIds ?? "")}`,
  )
  if (body.name === "MoviesSearch") searchTriggered = true
  return c.json({ id: 100, name: body.name, status: "queued" })
})
radarr.get("/api/v3/command/100", (c) =>
  c.json({ id: 100, status: "completed" }),
)
radarr.get("/api/v3/blocklist", (c) => c.json({ page: 1, records: [] }))
radarr.all("*", (c) => {
  calls.push(`radarr UNHANDLED ${c.req.method} ${c.req.path}`)
  return c.json({}, 404)
})

const s1 = serve({ fetch: seerr.fetch, port: 5056 })
const s2 = serve({ fetch: radarr.fetch, port: 7879 })

const config = loadConfig()
const runner = new IssueRunner(
  config,
  await ModelRuntime.create(),
  config.model ?? DEFAULT_MODEL,
)
const started = Date.now()
try {
  const outcome = await runner.run({
    kind: "webhook",
    issueId: "9",
    payload: {
      notification_type: "ISSUE_CREATED",
      event: "New Video Issue Reported",
      subject: "The Matrix (1999)",
      message:
        "Der Film ruckelt stark und ab Minute 20 ist das Bild komplett kaputt (Artefakte, Blöcke). Bitte neu laden.",
      media: {
        media_type: "movie",
        tmdbId: "603",
        tvdbId: "",
        status: "AVAILABLE",
        status4k: "UNKNOWN",
      },
      issue: {
        issue_id: "9",
        issue_type: "VIDEO",
        issue_status: "OPEN",
        reportedBy_username: "zekurio",
      },
      comment: null,
      extra: [],
    },
  })
  console.log("\n=== OUTCOME ===")
  console.log(JSON.stringify(outcome.directives, null, 2))
} catch (err) {
  console.error("\n=== RUN FAILED ===\n", err)
}
console.log(
  `\n=== ${Math.round((Date.now() - started) / 1000)}s, MOCK CALL LOG ===`,
)
for (const call of calls) console.log(" -", call)
s1.close()
s2.close()
process.exit(0)
