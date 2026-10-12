import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http"

import { Cause, Effect } from "effect"

import type { Gateways, Intake } from "./gateway.ts"

export interface ServerDeps {
  gateways: Gateways
  intake: Intake
  stats: () => { queued: number }
}

const WEBHOOK_PREFIX = "/webhook/"

/**
 * The listener for `GET /healthz` and `POST /webhook/<gateway>`. What a
 * webhook means is the gateway's business; this only finds it, checks its
 * secret, and reads the body.
 */
export function createApp(deps: ServerDeps): RequestListener {
  return (request, response) => {
    Effect.runFork(
      handleRequest(request, response, deps).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error("[http] request failed:", Cause.squash(cause))
            json(response, 500, { error: "internal server error" })
          }),
        ),
      ),
    )
  }
}

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ServerDeps,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, { status: "ok", ...deps.stats() })
      return
    }
    const gateway =
      request.method === "POST" && url.pathname.startsWith(WEBHOOK_PREFIX)
        ? deps.gateways.find(url.pathname.slice(WEBHOOK_PREFIX.length))
        : undefined
    if (!gateway) {
      json(response, 404, { error: "not found" })
      return
    }
    if (!gateway.authorized(request.headers.authorization)) {
      json(response, 401, { error: "unauthorized" })
      return
    }
    const body = yield* readJson(request).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (body === undefined || body === null) {
      json(response, 400, { error: "invalid JSON" })
      return
    }
    json(response, 200, yield* gateway.webhookEffect(body, deps.intake))
  })
}

function readJson(
  request: IncomingMessage,
): Effect.Effect<unknown, Cause.UnknownError> {
  return Effect.tryPromise(async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  })
}

function json(response: ServerResponse, status: number, body: object): void {
  const content = JSON.stringify(body)
  response.writeHead(status, {
    "content-length": Buffer.byteLength(content),
    "content-type": "application/json; charset=UTF-8",
  })
  response.end(content)
}
