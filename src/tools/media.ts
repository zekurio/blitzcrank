import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"

import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { MediaConfig } from "../config.js"
import { textResult } from "./common.js"
import { execFileText } from "./exec.js"

/**
 * ffprobe-backed media inspection: the only source of file truth about audio
 * and subtitle languages.
 *
 * Sonarr/Radarr `languages` is parsed from the *release name* — a `MULTi`,
 * `DL`, or `German` tag is a claim, not a fact — and Jellyfin's real stream
 * data only exists after import, which is too late for a grab decision. This
 * tool answers "is that track actually in the file?" before anything is
 * replaced.
 *
 * Read-only and root-constrained: the target is resolved through `realpath`
 * and must land inside a configured media root, so neither a symlink nor a
 * path pasted into an issue can reach outside the media directories. The probe
 * result is deliberately *not* recorded as run evidence: stream titles are
 * attacker-controllable text and must never be able to satisfy a mutation's ID
 * evidence gate.
 */

const MEDIA_EXTENSIONS = new Set([
  ".mkv",
  ".mp4",
  ".m4v",
  ".avi",
  ".ts",
  ".m2ts",
  ".mov",
  ".webm",
  ".mpg",
  ".mpeg",
  ".wmv",
  ".flv",
  ".ogm",
  ".divx",
])

const MAX_WALK_ENTRIES = 4000
const MAX_WALK_DEPTH = 4
const MAX_STREAMS = 100
const MAX_PROBES_PER_RUN = 25
const PROBE_TIMEOUT_MS = 30_000

export function buildMediaTools(cfg: MediaConfig): ToolDefinition[] {
  let probes = 0
  return [
    defineTool({
      name: "media_probe",
      label: "Probe media file",
      description:
        "Inspect the real audio/subtitle/video streams of a media file with ffprobe. This is the only trustworthy " +
        "answer to which languages a file contains: Sonarr/Radarr `languages` is parsed from the release name " +
        "(MULTi, DL, German are claims, not facts) and Jellyfin stream data only exists after import. Works on " +
        "completed downloads before import and on library files. Accepts an absolute file path or a release " +
        "directory (the largest media file below it is probed). Read-only; paths outside the configured media " +
        "roots are rejected.",
      parameters: Type.Object({
        purpose: Type.String({
          description:
            "What this probe must establish, e.g. whether a German audio track exists in the grabbed release",
        }),
        path: Type.String({
          description:
            "Absolute file or release-directory path taken from a service read (Arr file path or queue outputPath, SABnzbd storage, Jellyfin MediaSources Path); never a guessed or user-supplied path",
        }),
      }),
      async execute(_toolCallId, params, signal) {
        if (probes >= MAX_PROBES_PER_RUN) {
          throw new Error(
            `media_probe may be called at most ${MAX_PROBES_PER_RUN} times per run; probe one representative file instead`,
          )
        }
        probes++

        const target = await resolveMediaPath(params.path, cfg.roots)
        const info = await stat(target)
        const file = info.isDirectory()
          ? await largestMediaFile(target)
          : { path: target, size: info.size }
        if (!file) {
          throw new Error(
            `no media file found under ${target} (searched ${MAX_WALK_DEPTH} levels deep for ${[...MEDIA_EXTENSIONS].join(", ")})`,
          )
        }

        const stdout = await execFileText(
          cfg.ffprobe,
          [
            "-v",
            "error",
            "-show_entries",
            "stream=index,codec_type,codec_name,channels,channel_layout:stream_tags=language,title:stream_disposition=default,forced:format=duration",
            "-of",
            "json",
            file.path,
          ],
          { signal, timeoutMs: PROBE_TIMEOUT_MS },
        )

        return textResult(
          {
            ...summarizeProbe(stdout),
            file: file.path,
            sizeBytes: file.size,
            ...(info.isDirectory() ? { pickedFrom: target } : {}),
          },
          { action: "media_probe", file: file.path },
        )
      },
    }),
  ]
}

/**
 * Resolves an agent-supplied path to a real path inside a configured media
 * root. Symlinks are resolved *before* the containment check, so a link inside
 * a root cannot be used to read outside it.
 */
export async function resolveMediaPath(
  raw: string,
  roots: string[],
): Promise<string> {
  const input = raw.trim()
  if (!path.isAbsolute(input) || input.includes("\0")) {
    throw new Error(
      "path must be an absolute filesystem path inside a configured media root",
    )
  }
  const target = await realpath(path.resolve(input))
  const allowed = await Promise.all(
    roots.map((root) => realpath(root).catch(() => path.resolve(root))),
  )
  const contained = allowed.some(
    (root) => target === root || target.startsWith(root + path.sep),
  )
  if (!contained) {
    throw new Error(
      `path is outside the media roots blitzcrank may read (${roots.join(", ")})`,
    )
  }
  return target
}

/**
 * Picks the largest media file below a release directory — the agent usually
 * has a folder (SABnzbd `storage`, Arr `outputPath`), not a file. Symlinked
 * entries are skipped entirely (`isFile`/`isDirectory` are false for them), so
 * the walk stays inside the already-validated directory.
 */
export async function largestMediaFile(
  dir: string,
): Promise<{ path: string; size: number } | undefined> {
  let best: { path: string; size: number } | undefined
  let seen = 0
  const pending = [{ dir, depth: 0 }]
  while (pending.length > 0) {
    const current = pending.shift()!
    for (const entry of await readdir(current.dir, { withFileTypes: true })) {
      if (++seen > MAX_WALK_ENTRIES) {
        throw new Error(
          `directory ${dir} has more than ${MAX_WALK_ENTRIES} entries; pass an exact file path`,
        )
      }
      const full = path.join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < MAX_WALK_DEPTH) {
          pending.push({ dir: full, depth: current.depth + 1 })
        }
        continue
      }
      if (!entry.isFile()) continue
      if (!MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue
      }
      const size = (await stat(full)).size
      if (!best || size > best.size) best = { path: full, size }
    }
  }
  return best
}

interface FfprobeStream {
  index?: number
  codec_type?: string
  codec_name?: string
  channels?: number
  channel_layout?: string
  tags?: { language?: string; title?: string }
  disposition?: Record<string, number>
}

/** Compacts ffprobe JSON to the language-decision facts, in few tokens. */
export function summarizeProbe(stdout: string) {
  const payload = JSON.parse(stdout) as {
    streams?: FfprobeStream[]
    format?: { duration?: string }
  }
  const streams = (payload.streams ?? [])
    .slice(0, MAX_STREAMS)
    .map((stream) => ({
      index: stream.index,
      type: stream.codec_type,
      codec: stream.codec_name,
      language: stream.tags?.language ?? "und",
      ...(stream.tags?.title ? { title: stream.tags.title.slice(0, 120) } : {}),
      ...(stream.channels !== undefined ? { channels: stream.channels } : {}),
      ...(stream.channel_layout ? { layout: stream.channel_layout } : {}),
      ...(stream.disposition?.default ? { default: true } : {}),
      ...(stream.disposition?.forced ? { forced: true } : {}),
    }))
  const languagesOf = (type: string) => [
    ...new Set(streams.filter((s) => s.type === type).map((s) => s.language)),
  ]
  const duration = Number(payload.format?.duration)
  return {
    audioLanguages: languagesOf("audio"),
    subtitleLanguages: languagesOf("subtitle"),
    ...(Number.isFinite(duration)
      ? { durationSeconds: Math.round(duration) }
      : {}),
    streams,
    truncated: (payload.streams ?? []).length > MAX_STREAMS,
    note:
      "Languages are the file's own stream tags (ISO 639-2: German is ger or deu, Japanese jpn); " +
      '"und" means the track carries no language tag. This is file truth and outranks Arr release-name metadata.',
  }
}
