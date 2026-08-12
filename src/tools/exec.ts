import { execFile } from "node:child_process"

const MAX_ERROR_DETAIL_CHARS = 8_000

/** Carries the helper's exit status for useful tool errors. */
export class ExecError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | undefined,
  ) {
    super(message)
    this.name = "ExecError"
  }
}

/**
 * Runs a local helper binary and returns stdout.
 * Never uses a shell: arguments are passed as an array, so nothing in a path
 * or id can be interpreted as a command. Failures throw with the tool's own
 * stderr, which pi hands back to the model as a tool error.
 */
export function execFileText(
  file: string,
  args: string[],
  opts: {
    signal?: AbortSignal | undefined
    timeoutMs?: number | undefined
    maxBufferBytes?: number | undefined
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        ...(opts.signal ? { signal: opts.signal } : {}),
        timeout: opts.timeoutMs ?? 10_000,
        maxBuffer: opts.maxBufferBytes ?? 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const rawDetail = String(stderr || stdout || error.message).trim()
          const detail =
            rawDetail.length <= MAX_ERROR_DETAIL_CHARS
              ? rawDetail
              : `... [omitted ${rawDetail.length - MAX_ERROR_DETAIL_CHARS} chars]\n${rawDetail.slice(-MAX_ERROR_DETAIL_CHARS)}`
          const status = (error as { code?: number | string }).code
          reject(
            new ExecError(
              detail || error.message,
              typeof status === "number" ? status : undefined,
            ),
          )
          return
        }
        resolve(String(stdout))
      },
    )
  })
}
