/** Minimal JSON HTTP helper for the service tool implementations. */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 500)}`)
    this.name = "HttpError"
  }
}

export interface JsonRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | undefined
  headers?: Headers | Record<string, string> | undefined
  query?: Record<string, string | number | boolean | undefined> | undefined
  body?: JsonValue | undefined
  timeoutMs?: number | undefined
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }

export async function jsonRequest<T = JsonValue>(
  baseUrl: string,
  path: string,
  opts: JsonRequestOptions = {},
): Promise<T> {
  const url = new URL(
    path.replace(/^\//, ""),
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  )
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  const headers = new Headers(opts.headers)
  headers.set("accept", "application/json")
  if (opts.body !== undefined) headers.set("content-type", "application/json")
  const request: RequestInit = {
    method: opts.method ?? "GET",
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  }
  if (opts.body !== undefined) request.body = JSON.stringify(opts.body)
  const res = await fetch(url, request)

  const text = await res.text()
  if (!res.ok) {
    throw new HttpError(res.status, url.toString(), text)
  }
  if (!text) {
    // SAFETY: Callers ignore the value for successful empty service responses.
    return undefined as T
  }
  try {
    // SAFETY: Each typed caller owns the response contract for its fixed endpoint.
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(`Expected JSON from ${url}`, { cause: err })
  }
}
