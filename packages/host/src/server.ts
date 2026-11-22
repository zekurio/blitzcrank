import type { RequestListener, ServerResponse } from "node:http"

export interface ServerDeps {
  stats: () => { queued: number }
}

/**
 * The listener for `GET /healthz`. No gateway takes inbound HTTP: each one
 * connects to its platform itself.
 */
export function createApp(deps: ServerDeps): RequestListener {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, { status: "ok", ...deps.stats() })
      return
    }
    json(response, 404, { error: "not found" })
  }
}

function json(response: ServerResponse, status: number, body: object): void {
  const content = JSON.stringify(body)
  response.writeHead(status, {
    "content-length": Buffer.byteLength(content),
    "content-type": "application/json; charset=UTF-8",
  })
  response.end(content)
}
