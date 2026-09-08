import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { createServer } from "node:http"
import test from "node:test"

import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { runArrFileDelete } from "../tools/arr-common.js"
import { runMutation } from "../tools/common.js"
import { RunContext } from "../tools/context.js"
import {
  HttpError,
  HttpRequestError,
  HttpResponseError,
  HttpTimeoutError,
  jsonRequest,
  jsonRequestEffect,
} from "./http.js"

test("HTTP adapters preserve requests, errors, and mutation verification", async (t) => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (request.url === "/empty" || request.method === "DELETE") {
      response.writeHead(204).end()
      return
    }
    if (request.url === "/api/v3/moviefile/7") {
      response.writeHead(404).end("not found")
      return
    }
    if (request.url === "/unavailable") {
      response.writeHead(503).end("service down")
      return
    }
    if (request.url === "/invalid") {
      response.end("not JSON")
      return
    }
    request.setEncoding("utf8")
    let body = ""
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => {
      response.end(
        JSON.stringify({
          url: request.url,
          method: request.method,
          accept: request.headers.accept,
          contentType: request.headers["content-type"],
          apiKey: request.headers["x-api-key"],
          body,
        }),
      )
    })
  })
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const base = `http://127.0.0.1:${address.port}`

  const request = jsonRequestEffect(`${base}/prefix`, "/echo?keep=yes", {
    method: "POST",
    headers: { "X-Api-Key": "test-key" },
    query: { zero: 0, disabled: false, empty: "", omitted: undefined },
    body: { enabled: false },
  })
  assert.deepEqual(requests, [])
  assert.deepEqual(await Effect.runPromise(request), {
    url: "/prefix/echo?keep=yes&zero=0&disabled=false&empty=",
    method: "POST",
    accept: "application/json",
    contentType: "application/json",
    apiKey: "test-key",
    body: '{"enabled":false}',
  })
  assert.equal(await jsonRequest(base, "/empty"), undefined)
  const sent = requests.length
  await assert.rejects(
    jsonRequest(base, "/empty", {
      signal: AbortSignal.abort(),
    }),
    HttpRequestError,
  )
  assert.equal(requests.length, sent)
  await assert.rejects(jsonRequest(base, "/unavailable"), (error) => {
    assert.ok(error instanceof HttpError)
    assert.equal(error._tag, "HttpError")
    assert.equal(error.status, 503)
    assert.equal(error.body, "service down")
    assert.match(error.message, /HTTP 503/)
    return true
  })
  await assert.rejects(jsonRequest(base, "/invalid"), (error) => {
    assert.ok(error instanceof HttpResponseError)
    assert.ok(error.cause instanceof SyntaxError)
    assert.equal(error.message, `Expected JSON from ${base}/invalid`)
    return true
  })
  assert.equal(
    await Effect.runPromise(
      jsonRequestEffect(base, "/unavailable").pipe(
        Effect.catchTag("HttpError", (error) => Effect.succeed(error.status)),
      ),
    ),
    503,
  )

  const ctx = new RunContext()
  ctx.recordRead("radarr", "/api/v3/moviefile/7", '{"id":7}')
  const deletion = await runArrFileDelete(
    { url: base, apiKey: "test-key" },
    "radarr",
    ctx,
    "/api/v3/moviefile/7",
    7,
    "movie file",
    "movie file",
  )
  assert.deepEqual(deletion.verification, {
    confirmed: "movie file no longer present (HTTP 404)",
  })

  const outcome = await runMutation(ctx, {
    kind: "mutate",
    perform: () => jsonRequest(base, "/empty", { method: "POST" }),
    verify: () => jsonRequest(base, "/unavailable"),
  })
  assert.match(outcome.verificationError ?? "", /HTTP 503/)
  assert.equal(requests.filter((entry) => entry === "POST /empty").length, 1)
  // SABnzbd mutations also use GET; an error must not repeat the request.
  assert.equal(
    requests.filter((entry) => entry === "GET /unavailable").length,
    3,
  )
})

test("request setup and transport failures stay in the typed error channel", async (t) => {
  const cause = new Error("connection refused")
  const fetch = t.mock.method(globalThis, "fetch", () => Promise.reject(cause))
  await assert.rejects(jsonRequest("not a URL", "/"), HttpRequestError)
  for (const timeoutMs of [-1, NaN, Infinity, 0.5, 0x100000000]) {
    await assert.rejects(
      jsonRequest("http://example.test", "/", { timeoutMs }),
      HttpRequestError,
    )
  }
  assert.equal(fetch.mock.callCount(), 0)
  await assert.rejects(jsonRequest("http://example.test", "/"), (error) => {
    assert.ok(error instanceof HttpRequestError)
    assert.equal(error.cause, cause)
    return true
  })
  assert.equal(fetch.mock.callCount(), 1)
})

test("the Effect timeout aborts a stalled body and uses the test clock", async (t) => {
  let aborted = false
  t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => {
    const signal = init.signal
    assert.ok(signal)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'))
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
            controller.error(signal.reason)
          },
          { once: true },
        )
      },
    })
    return Promise.resolve(new Response(body))
  })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* jsonRequestEffect("http://example.test", "/", {
        timeoutMs: 60_000,
      }).pipe(
        Effect.catchTag("HttpTimeoutError", (error) => Effect.succeed(error)),
        Effect.forkChild,
      )
      yield* TestClock.adjust("1 minute")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())),
  )
  assert.ok(result instanceof HttpTimeoutError)
  assert.equal(result.timeoutMs, 60_000)
  assert.equal(aborted, true)
})

test(
  "fiber interruption aborts the underlying fetch",
  { timeout: 5000 },
  async (t) => {
    const started = new EventEmitter()
    const ready = once(started, "fetch")
    t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => {
      const signal = init.signal
      assert.ok(signal)
      started.emit("fetch", signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      })
    })
    const fiber = Effect.runFork(jsonRequestEffect("http://example.test", "/"))
    t.after(() => Effect.runPromise(Fiber.interrupt(fiber)))
    const [signal] = await ready
    assert.ok(signal instanceof AbortSignal)
    await Effect.runPromise(Fiber.interrupt(fiber))
    assert.equal(signal.aborted, true)
  },
)
