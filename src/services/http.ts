/** Minimal JSON HTTP helper for the service tool implementations. */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

export interface JsonRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | undefined;
  headers?: Record<string, string> | undefined;
  query?: Record<string, string | number | boolean | undefined> | undefined;
  body?: unknown;
  timeoutMs?: number | undefined;
}

export async function jsonRequest<T = unknown>(
  baseUrl: string,
  path: string,
  opts: JsonRequestOptions = {},
): Promise<T> {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(res.status, url.toString(), text);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
