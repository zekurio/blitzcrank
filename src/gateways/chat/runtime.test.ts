import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import type { AutomationReport } from "../../automations/runner.ts"
import {
  connectGateways,
  initializeGateway,
  publishToGateways,
  stopGateways,
  type GatewayRuntime,
} from "./runtime.ts"

const report: AutomationReport = {
  name: "test",
  status: "ok",
  body: "done",
  reads: 0,
  mutations: 0,
  deletes: 0,
  tokens: 0,
  malformed: false,
  empty: false,
}

test("a failed report sink does not prevent other gateways", async () => {
  const delivered: string[] = []
  const gateways: GatewayRuntime[] = [
    {
      id: "broken",
      reportEffect: () => Effect.fail("offline"),
      stopEffect: () => Effect.void,
    },
    {
      id: "throws",
      reportEffect: () => {
        throw new Error("report factory failed")
      },
      stopEffect: () => Effect.void,
    },
    {
      id: "working",
      reportEffect: () =>
        Effect.sync(() => {
          delivered.push("working")
        }),
      stopEffect: () => Effect.void,
    },
  ]

  await Effect.runPromise(publishToGateways(gateways, report))

  assert.deepEqual(delivered, ["working"])
})

test("a failed gateway stop does not prevent other gateways stopping", async () => {
  const stopped: string[] = []
  const gateways: GatewayRuntime[] = [
    {
      id: "broken",
      reportEffect: () => Effect.void,
      stopEffect: () => Effect.fail("stuck"),
    },
    {
      id: "throws",
      reportEffect: () => Effect.void,
      stopEffect: () => {
        throw new Error("stop factory failed")
      },
    },
    {
      id: "working",
      reportEffect: () => Effect.void,
      stopEffect: () =>
        Effect.sync(() => {
          stopped.push("working")
        }),
    },
  ]

  await Effect.runPromise(stopGateways(gateways))

  assert.deepEqual(stopped, ["working"])
})

test("gateways connect concurrently and contain failed or hung startup", async () => {
  const events: string[] = []
  const working: GatewayRuntime = {
    id: "working",
    reportEffect: () => Effect.void,
    stopEffect: () => Effect.void,
  }
  const gateways = await Effect.runPromise(
    connectGateways([
      {
        id: "pending",
        start: () =>
          initializeGateway(
            "pending",
            Effect.never,
            () =>
              Effect.sync(() => {
                events.push("cleanup")
              }),
            10,
          ),
      },
      { id: "offline", start: () => Effect.fail(new Error("offline")) },
      {
        id: "throws",
        start: () => {
          throw new Error("startup factory failed")
        },
      },
      {
        id: "working",
        start: () =>
          Effect.sync(() => {
            events.push("connected")
            return working
          }),
      },
    ]),
  )
  assert.deepEqual(events, ["connected", "cleanup"])
  assert.deepEqual(gateways, [working])
})

test("timed-out setup cleans up once and cannot resume late initialization", async () => {
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const events: string[] = []
  const startup = initializeGateway(
    "pending",
    Effect.gen(function* () {
      yield* Effect.promise(() => ready)
      events.push("installed handlers")
    }),
    () =>
      Effect.sync(() => {
        events.push("destroyed client")
      }),
    10,
  )
  await assert.rejects(Effect.runPromise(startup), { _tag: "TimeoutError" })
  resolveReady()
  await ready
  assert.deepEqual(events, ["destroyed client"])
})

test("startup cleanup contains its own failure and preserves the setup error", async () => {
  const events: string[] = []
  await assert.rejects(
    Effect.runPromise(
      initializeGateway(
        "offline",
        Effect.fail(new Error("login failed")),
        () => {
          events.push("cleanup")
          throw new Error("cleanup failed")
        },
      ),
    ),
    /login failed/,
  )
  assert.deepEqual(events, ["cleanup"])
})

test("successful initialization retains the connection", async () => {
  let cleaned = false
  assert.equal(
    await Effect.runPromise(
      initializeGateway("ready", Effect.succeed("connected"), () =>
        Effect.sync(() => {
          cleaned = true
        }),
      ),
    ),
    "connected",
  )
  assert.equal(cleaned, false)
})
