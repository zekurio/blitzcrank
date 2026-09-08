import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, Socket } from "node:net"
import test from "node:test"

import { Effect, Fiber } from "effect"

import { ExecError, execFileText, execFileTextEffect } from "./exec.js"

test(
  "interrupting the Effect terminates the local helper",
  { timeout: 5000 },
  async (t) => {
    const server = createServer()
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    )
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const accepted = once(server, "connection")
    const fiber = Effect.runFork(
      execFileTextEffect(process.execPath, [
        "-e",
        `require('node:net').connect(${address.port}, '127.0.0.1'); setInterval(() => {}, 1000)`,
      ]),
    )
    t.after(() => Effect.runPromise(Fiber.interrupt(fiber)))
    const [socket] = await accepted
    assert.ok(socket instanceof Socket)
    t.after(() => socket.destroy())
    const closed = once(socket, "close")
    await Effect.runPromise(Fiber.interrupt(fiber))
    await closed
  },
)

test("process adapters preserve literal arguments and typed exit codes", async () => {
  const literal = "$(echo should-not-run); `echo neither`"
  assert.equal(
    await Effect.runPromise(
      execFileTextEffect(process.execPath, [
        "-e",
        "process.stdout.write(process.argv[1])",
        literal,
      ]),
    ),
    literal,
  )
  for (const code of [2, 3, 4]) {
    await assert.rejects(
      execFileText(process.execPath, [
        "-e",
        `process.stderr.write('helper failed'); process.exit(${code})`,
      ]),
      (error) => {
        assert.ok(error instanceof ExecError)
        assert.equal(error._tag, "ExecError")
        assert.equal(error.exitCode, code)
        assert.equal(error.message, "helper failed")
        return true
      },
    )
  }
  assert.equal(
    await Effect.runPromise(
      execFileTextEffect(process.execPath, ["-e", "process.exit(3)"]).pipe(
        Effect.catchTag("ExecError", (error) => Effect.succeed(error.exitCode)),
      ),
    ),
    3,
  )
})

test("process errors retain output limits, timeouts, and cancellation", async () => {
  await assert.rejects(
    execFileText(process.execPath, [
      "-e",
      "process.stderr.write('x'.repeat(9000)); process.exit(1)",
    ]),
    (error) => {
      assert.ok(error instanceof ExecError)
      assert.match(error.message, /^\.\.\. \[omitted 1000 chars\]/)
      assert.ok(error.message.length < 8100)
      return true
    },
  )
  await assert.rejects(
    execFileText(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096))"],
      { maxBufferBytes: 16 },
    ),
    ExecError,
  )
  await assert.rejects(
    execFileText(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 50,
    }),
    ExecError,
  )
  await assert.rejects(
    execFileText(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      signal: AbortSignal.abort(),
    }),
    ExecError,
  )
  await assert.rejects(
    execFileText("/nonexistent/blitzcrank-test-helper", []),
    (error) => {
      assert.ok(error instanceof ExecError)
      assert.equal(error.exitCode, undefined)
      assert.match(error.message, /ENOENT/)
      return true
    },
  )
})
