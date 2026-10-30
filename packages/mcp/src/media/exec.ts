import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { Effect } from "effect"

import { ToolError } from "../tools/errors.ts"

const MAX_ERROR_DETAIL_CHARS = 8_000
const execFileAsync = promisify(execFile)

/** A contained file must not open playlists, other files, or network inputs. */
export const MEDIA_INPUT_ARGS = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,mpegts,mpeg,asf,flv,ogg",
]

/**
 * Runs a local helper binary (ffprobe, ffmpeg) and returns its stdout. Never
 * uses a shell: arguments are passed as an array, so nothing in a path or id
 * can be interpreted as a command. A failure carries the tail of the helper's
 * own stderr, which the model gets back as the tool error.
 */
export function execFileEffect(
  file: string,
  args: string[],
  opts: { signal: AbortSignal; timeoutMs: number; maxBufferBytes: number },
): Effect.Effect<Buffer, ToolError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const result = await execFileAsync(file, args, {
        encoding: "buffer",
        signal: AbortSignal.any([signal, opts.signal]),
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBufferBytes,
      })
      return result.stdout
    },
    catch: (cause) => {
      // Node's promisified execFile adds captured output to its rejection.
      const error = cause as Error & { stderr?: Buffer }
      const stderr = String(error.stderr ?? "").trim()
      const detail =
        stderr.length <= MAX_ERROR_DETAIL_CHARS
          ? stderr
          : `... [omitted ${stderr.length - MAX_ERROR_DETAIL_CHARS} chars]\n${stderr.slice(-MAX_ERROR_DETAIL_CHARS)}`
      return new ToolError({
        message: `${file} failed: ${detail || error.message}`,
      })
    },
  })
}
