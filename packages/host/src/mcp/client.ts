import { readFile } from "node:fs/promises"

import {
  McpAuthRequiredError,
  McpClient,
  StreamableHttpTransport,
  type CallToolResult,
  type Tool,
} from "@earendil-works/pi-mcp"
import { Data, Effect } from "effect"

import type { McpConfig } from "../config.ts"

/**
 * Must outlast every service call the server makes for one tool call. A
 * client timeout during a write leaves its outcome unknown and stops the run
 * for review, so the server's own limits have to fire first.
 */
const CALL_TIMEOUT_MS = 180_000

export class McpConnectError extends Data.TaggedError("McpConnectError")<{
  message: string
  cause: unknown
}> {}

export interface McpConnection {
  /** The server's tool list as of this connection. */
  tools: readonly Tool[]
  /**
   * Domain failures come back as `isError` results. A rejection means the
   * call has no result: a transport failure, timeout, or abort, or the server
   * reporting a write whose outcome it does not know.
   */
  callTool: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) => Promise<CallToolResult>
  /** Idempotent. The scope that opened the connection already calls it. */
  close: () => Promise<void>
}

/**
 * One connection for one run. It closes with the enclosing scope, so a caller
 * cannot leak it past a failed or stopped run.
 */
export function connectMcpEffect(config: McpConfig, signal?: AbortSignal) {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: (interruption) =>
        connect(
          config,
          signal ? AbortSignal.any([signal, interruption]) : interruption,
        ),
      catch: (cause) =>
        new McpConnectError({ message: connectFailure(config, cause), cause }),
    }),
    (connection) => Effect.promise(() => connection.close()),
  )
}

async function connect(
  config: McpConfig,
  signal: AbortSignal,
): Promise<McpConnection> {
  // The package root holds package.json next to dist/ and src/ alike.
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
  const client = new McpClient({
    name: "blitzcrank",
    version: manifest.version,
  })
  await client.connect(
    new StreamableHttpTransport({
      url: config.url,
      headers: { Authorization: `Bearer ${config.token}` },
      // The server is stateless and answers each POST with JSON. It serves
      // no server-to-client stream, so do not probe for one on every run.
      openGetStream: false,
    }),
  )
  const close = () =>
    client.close().then(undefined, (cause: unknown) => {
      console.warn("[mcp] closing the connection failed:", cause)
    })
  const tools = await client
    .listTools({ signal })
    .then(undefined, async (cause: unknown) => {
      await close()
      throw cause
    })
  return {
    tools,
    callTool: (name, args, callSignal) =>
      client.callTool(name, args, {
        timeoutMs: CALL_TIMEOUT_MS,
        ...(callSignal ? { signal: callSignal } : {}),
      }),
    close,
  }
}

function connectFailure(config: McpConfig, cause: unknown): string {
  if (cause instanceof McpAuthRequiredError)
    return `MCP server at ${config.url} rejected BLITZCRANK_MCP_TOKEN`
  const reason = cause instanceof Error ? cause.message : String(cause)
  return `MCP server at ${config.url} is unreachable: ${reason}`
}
