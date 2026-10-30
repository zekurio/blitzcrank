import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"

import { Effect } from "effect"

import { toolCheck, ToolError } from "../tools/errors.ts"

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

const OUTSIDE_ROOTS =
  "path is not inside the media directories blitzcrank may read; use the exact file or " +
  "release path a service read returned, not a rewritten or guessed one"

/**
 * Resolves an agent-supplied path to a real path inside a configured media
 * root. Symlinks are resolved *before* the containment check, so a link inside
 * a root cannot be used to read outside it.
 *
 * Failures outside the roots are reported with one generic message: issue text
 * is untrusted, and distinguishing "does not exist" from "exists but is not
 * yours" would turn the tool into an existence oracle for the whole host.
 */
export function resolveMediaPathEffect(
  raw: string,
  roots: readonly string[],
): Effect.Effect<string, ToolError> {
  return Effect.gen(function* () {
    const lexical = yield* toolCheck(() => {
      const input = raw.trim()
      if (!path.isAbsolute(input) || input.includes("\0")) {
        throw new Error(
          "path must be an absolute filesystem path inside a media directory blitzcrank may read",
        )
      }
      return path.resolve(input)
    })
    const resolvedRoots = yield* Effect.forEach(
      roots,
      (root) =>
        Effect.tryPromise(() => realpath(root)).pipe(
          Effect.catch(() => Effect.succeed(root)),
        ),
      { concurrency: "unbounded" },
    )
    const allowed = resolvedRoots.concat(roots)
    const inside = (candidate: string) =>
      allowed.some(
        (root) => candidate === root || candidate.startsWith(root + path.sep),
      )
    const target = yield* Effect.tryPromise(() => realpath(lexical)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    return yield* toolCheck(() => {
      if (target === undefined) {
        // Only admit that a path is missing when it was one we would have read.
        if (!inside(lexical)) throw new Error(OUTSIDE_ROOTS)
        throw new Error(`no such file or directory: ${lexical}`)
      }
      if (!inside(target)) throw new Error(OUTSIDE_ROOTS)
      return target
    })
  })
}

/** Filesystem failures on an already admitted path, as a tool failure. */
export function fsEffect<A>(
  run: () => Promise<A>,
): Effect.Effect<A, ToolError> {
  return Effect.tryPromise({
    try: run,
    catch: (error) =>
      new ToolError({
        message: error instanceof Error ? error.message : String(error),
      }),
  })
}

interface MediaFile {
  path: string
  size: number
}

/**
 * Picks the largest media file below a release directory. The agent usually
 * has a folder (SABnzbd `storage`, Arr `outputPath`), not a file. Symlinked
 * entries are skipped entirely (`isFile`/`isDirectory` are false for them), so
 * the walk stays inside the already-validated directory. A hardlink into the
 * directory is indistinguishable from a regular file by design: whatever can
 * write into a media root can already place bytes there.
 */
export function largestMediaFileEffect(
  dir: string,
): Effect.Effect<MediaFile, ToolError> {
  return Effect.gen(function* () {
    const found: MediaFile[] = []
    const pending = [{ dir, depth: 0 }]
    let seen = 0
    for (const current of pending) {
      const entries = yield* fsEffect(() =>
        readdir(current.dir, { withFileTypes: true }),
      )
      for (const entry of entries) {
        seen += 1
        // Huge tree: answer with the best candidate found so far rather
        // than failing the whole probe.
        if (seen > MAX_WALK_ENTRIES) break
        const full = path.join(current.dir, entry.name)
        if (entry.isDirectory() && current.depth < MAX_WALK_DEPTH) {
          pending.push({ dir: full, depth: current.depth + 1 })
        }
        if (
          entry.isFile() &&
          MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ) {
          const info = yield* fsEffect(() => stat(full))
          found.push({ path: full, size: info.size })
        }
      }
      if (seen > MAX_WALK_ENTRIES) break
    }
    const best = found.toSorted((a, b) => b.size - a.size)[0]
    if (best) return best
    return yield* Effect.fail(
      new ToolError({
        message:
          seen > MAX_WALK_ENTRIES
            ? `no media file in the first ${MAX_WALK_ENTRIES} entries of ${dir}; pass an exact file path`
            : `no media file found under ${dir} (searched ${MAX_WALK_DEPTH} levels deep for ${[...MEDIA_EXTENSIONS].join(", ")})`,
      }),
    )
  })
}
