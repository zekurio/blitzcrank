import { execFile } from "node:child_process"

/** Carries the helper's exit status, which is part of anvilctl's contract. */
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
 * Runs a local helper binary (anvilctl, ffprobe) and returns stdout.
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
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        ...(opts.signal ? { signal: opts.signal } : {}),
        timeout: opts.timeoutMs ?? 10_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim()
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
