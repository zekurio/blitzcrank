import { createHash, timingSafeEqual } from "node:crypto"
import http from "node:http"

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"
import { Data, Effect } from "effect"

import { runTool, type ServerTool } from "./tools.ts"

/** Tool arguments are small; nothing legitimate comes close. */
const MAX_BODY_BYTES = 1024 * 1024

class RequestRejected extends Data.TaggedError("RequestRejected")<{
  status: number
  code: number
  message: string
}> {}

export interface ServerOptions {
  token: string
  version: string
  tools: readonly ServerTool[]
}

/**
 * The listener for `POST /mcp` and `GET /healthz`. Stateless: every request
 * gets its own MCP server and transport over the shared tools, because a
 * stateless transport cannot be reused.
 */
export function createHttpServer(options: ServerOptions): http.Server {
  const registry = new Map(options.tools.map((tool) => [tool.name, tool]))
  const expected = digest(options.token)
  return http.createServer((req, res) => {
    // An event emitter cannot await its listener, so failures end here.
    Effect.runPromise(
      handleRequest(req, res, registry, expected, options.version),
    ).then(undefined, (cause: unknown) => {
      console.error("[mcp] request failed:", cause)
      if (res.headersSent) return res.destroy()
      sendRpcError(res, 500, ErrorCode.InternalError, "Internal server error")
    })
  })
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: Map<string, ServerTool>,
  expected: Buffer,
  version: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const pathname = (req.url ?? "/").split("?", 1)[0]
    if (pathname === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok")
      return
    }
    if (pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found")
      return
    }
    if (!authorized(req.headers.authorization, expected)) {
      res
        .writeHead(401, {
          "content-type": "text/plain",
          "www-authenticate": "Bearer",
        })
        .end("unauthorized")
      return
    }
    // No server-to-client stream and no session to delete.
    if (req.method !== "POST") {
      res.setHeader("allow", "POST")
      sendRpcError(res, 405, ErrorCode.ConnectionClosed, "Method not allowed.")
      return
    }
    const body = yield* readJsonBody(req)
    const server = mcpServer(registry, version)
    // No `sessionIdGenerator` is what makes the transport stateless.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    })
    // Closing the transport aborts the signal of a call still in flight.
    res.on("close", () => {
      transport.close().then(undefined, logCloseFailure)
      server.close().then(undefined, logCloseFailure)
    })
    // SAFETY: the SDK types its optional callbacks without `| undefined`,
    // which `exactOptionalPropertyTypes` rejects for its own transport.
    yield* Effect.promise(() => server.connect(transport as Transport))
    yield* Effect.promise(() => transport.handleRequest(req, res, body))
  }).pipe(
    Effect.catchTag("RequestRejected", (rejected) =>
      Effect.sync(() => {
        sendRpcError(res, rejected.status, rejected.code, rejected.message)
      }),
    ),
  )
}

function mcpServer(registry: Map<string, ServerTool>, version: string): Server {
  const server = new Server(
    { name: "blitzcrank-mcp", version },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...registry.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      annotations: tool.annotations,
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = registry.get(request.params.name)
    if (!tool) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown tool: ${request.params.name}`,
      )
    }
    const args = request.params.arguments ?? {}
    // Resolved first: a stale apply discards the plan that names its action.
    const label = tool.label(args) ?? "-"
    const started = performance.now()
    const result = await runTool(tool, args, extra.signal)
    // One line per call. Arguments may carry paths and titles; never log them.
    console.log(
      `[mcp] ${tool.name} ${label} ${result.isError ? "error" : "ok"} ${Math.round(performance.now() - started)}ms`,
    )
    return { ...result }
  })
  return server
}

/** Hashing first makes the comparison constant-time for any token length. */
function authorized(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer +(.+)$/i.exec(header ?? "")
  if (!match?.[1]) return false
  return timingSafeEqual(digest(match[1]), expected)
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest()
}

function readJsonBody(
  req: http.IncomingMessage,
): Effect.Effect<unknown, RequestRejected> {
  return Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: async () => {
        const chunks: Buffer[] = []
        let size = 0
        // An oversized body is drained, not buffered: leaving the loop early
        // would destroy the socket before the 413 could be sent.
        for await (const chunk of req as AsyncIterable<Buffer>) {
          size += chunk.length
          if (size <= MAX_BODY_BYTES) chunks.push(chunk)
        }
        if (size > MAX_BODY_BYTES) return undefined
        return Buffer.concat(chunks).toString("utf8")
      },
      catch: () =>
        new RequestRejected({
          status: 400,
          code: ErrorCode.ParseError,
          message: "Request body could not be read",
        }),
    })
    if (text === undefined) {
      return yield* Effect.fail(
        new RequestRejected({
          status: 413,
          code: ErrorCode.InvalidRequest,
          message: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
        }),
      )
    }
    return yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () =>
        new RequestRejected({
          status: 400,
          code: ErrorCode.ParseError,
          message: "Parse error: request body is not JSON",
        }),
    })
  })
}

function sendRpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }))
}

function logCloseFailure(cause: unknown): void {
  console.warn("[mcp] closing a request's transport failed:", cause)
}
