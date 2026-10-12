import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { Data, Effect } from "effect"

const MAX_ERROR_DETAIL_CHARS = 8_000
const execFileAsync = promisify(execFile)

/** A contained file must not open playlists, other files, or network inputs. */
export const MEDIA_INPUT_ARGS = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,mpegts,mpeg,asf,flv,ogg",
]

/** Carries the helper's exit status alongside its error output. */
export class ExecError extends Data.TaggedError("ExecError")<{
  message: string
  exitCode: number | undefined
}> {
  constructor(message: string, exitCode: number | undefined) {
    super({ message, exitCode })
  }
}

export interface ExecFileTextOptions {
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  maxBufferBytes?: number | undefined
}

/**
 * Runs a local helper binary (ffprobe) and returns stdout.
 * Never uses a shell: arguments are passed as an array, so nothing in a path
 * or id can be interpreted as a command. Failures throw with the tool's own
 * stderr, which pi hands back to the model as a tool error.
 */
export function execFileTextEffect(
  file: string,
  args: string[],
  opts: ExecFileTextOptions = {},
): Effect.Effect<string, ExecError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const result = await execFileAsync(file, args, {
        signal: opts.signal ? AbortSignal.any([signal, opts.signal]) : signal,
        timeout: opts.timeoutMs ?? 10_000,
        maxBuffer: opts.maxBufferBytes ?? 1024 * 1024,
      })
      return result.stdout
    },
    catch: (cause) => {
      // Node's promisified execFile adds captured output to its rejection.
      const error = cause as Error & {
        code?: number | string
        stdout?: string
        stderr?: string
      }
      const rawDetail = String(
        error.stderr || error.stdout || error.message,
      ).trim()
      const detail =
        rawDetail.length <= MAX_ERROR_DETAIL_CHARS
          ? rawDetail
          : `... [omitted ${rawDetail.length - MAX_ERROR_DETAIL_CHARS} chars]\n${rawDetail.slice(-MAX_ERROR_DETAIL_CHARS)}`
      return new ExecError(
        detail || error.message,
        typeof error.code === "number" ? error.code : undefined,
      )
    },
  })
}
