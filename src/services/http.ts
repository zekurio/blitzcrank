import { Data, Effect } from "effect"

export class HttpError extends Data.TaggedError("HttpError")<{
  status: number
  url: string
  body: string
}> {
  constructor(status: number, url: string, body: string) {
    super({ status, url, body })
    this.message = `HTTP ${status} for ${url}: ${body.slice(0, 500)}`
  }
}

export class HttpRequestError extends Data.TaggedError("HttpRequestError")<{
  cause: unknown
}> {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : "Service request failed"
  }
}

export class HttpResponseError extends Data.TaggedError("HttpResponseError")<{
  url: string
  cause: unknown
}> {
  override get message(): string {
    return `Expected JSON from ${this.url}`
  }
}

export class HttpTimeoutError extends Data.TaggedError("HttpTimeoutError")<{
  timeoutMs: number
}> {
  override get message(): string {
    return `Service request timed out after ${this.timeoutMs}ms`
  }
}

export type JsonRequestError =
  | HttpError
  | HttpRequestError
  | HttpResponseError
  | HttpTimeoutError

export interface JsonRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | undefined
  headers?: Headers | Record<string, string> | undefined
  query?: Record<string, string | number | boolean | undefined> | undefined
  body?: JsonValue | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }

/** Promise boundary for callers that have not migrated to Effect yet. */
export function jsonRequest<T = JsonValue>(
  baseUrl: string,
  path: string,
  opts: JsonRequestOptions = {},
): Promise<T> {
  return Effect.runPromise(jsonRequestEffect<T>(baseUrl, path, opts))
}

/** No retries: even GET can mutate state in SABnzbd. */
export function jsonRequestEffect<T = JsonValue>(
  baseUrl: string,
  path: string,
  opts: JsonRequestOptions = {},
): Effect.Effect<T, JsonRequestError> {
  return Effect.gen(function* () {
    const timeoutMs = opts.timeoutMs ?? 30_000
    const prepared = yield* Effect.try({
      try: () => {
        // Preserve the bounds previously enforced by AbortSignal.timeout.
        if (
          !Number.isInteger(timeoutMs) ||
          timeoutMs < 0 ||
          timeoutMs > 0xffffffff
        ) {
          throw new RangeError(
            "timeoutMs must be an integer between 0 and 4294967295",
          )
        }
        const url = new URL(
          path.replace(/^\//, ""),
          baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
        )
        for (const [key, value] of Object.entries(opts.query ?? {})) {
          if (value !== undefined) url.searchParams.set(key, String(value))
        }

        const headers = new Headers(opts.headers)
        headers.set("accept", "application/json")
        if (opts.body !== undefined) {
          headers.set("content-type", "application/json")
        }
        const request: RequestInit = { method: opts.method ?? "GET", headers }
        if (opts.body !== undefined) request.body = JSON.stringify(opts.body)
        return { url, request }
      },
      catch: (cause) => new HttpRequestError({ cause }),
    })

    // Keep fetch and body consumption inside the same abort lifetime.
    const response = yield* Effect.tryPromise({
      try: async (signal) => {
        const res = await fetch(prepared.url, {
          ...prepared.request,
          signal: opts.signal ? AbortSignal.any([signal, opts.signal]) : signal,
        })
        return { res, text: await res.text() }
      },
      catch: (cause) => new HttpRequestError({ cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new HttpTimeoutError({ timeoutMs })),
      }),
    )

    const url = prepared.url.toString()
    if (!response.res.ok) {
      return yield* Effect.fail(
        new HttpError(response.res.status, url, response.text),
      )
    }
    if (!response.text) {
      // SAFETY: Callers ignore successful empty service responses.
      return undefined as T
    }
    return yield* Effect.try({
      // SAFETY: Each typed caller owns the response contract for its endpoint.
      try: () => JSON.parse(response.text) as T,
      catch: (cause) => new HttpResponseError({ url, cause }),
    })
  })
}
