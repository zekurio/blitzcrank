import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"

import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import { buildAnvilTools, interpretJobLookup } from "./anvil.ts"
import { makeReadTool } from "./common.ts"
import { RunContext } from "./context.ts"
import { isReadTool } from "./index.ts"

const SOURCE_PATH = "/mnt/downloads/complete/Show/episode.mkv"
const CONVERTED_PATH = "/mnt/downloads/converted/Show/episode.mkv"

for (const field of ["droppedPath", "importedPath"]) {
  test(`Radarr history ${field} permits lookup but not retry`, async (t) => {
    const fake = await fakeAnvilctl()
    t.after(fake.cleanup)
    const ctx = new RunContext()
    const tools = buildAnvilTools(
      { command: fake.command, socket: "/tmp/anvild.sock" },
      ctx,
    )
    const read = makeReadTool(
      {
        service: "radarr",
        label: "Radarr",
        description: "Read Radarr history",
        request: () =>
          Effect.succeed({
            records: [
              {
                data: { [field]: SOURCE_PATH, message: "/untrusted/movie.mkv" },
              },
              { data: { [field]: "relative/movie.mkv" } },
              { data: { [field]: "/invalid\0/movie.mkv" } },
            ],
          }),
      },
      ctx,
    )
    await execute([read], "radarr_request", {
      path: "/api/v3/history?downloadId=test",
      purpose: "Find the exact import paths",
    })
    for (const target of [
      "/untrusted/movie.mkv",
      "/different/movie.mkv",
      "relative/movie.mkv",
      "/invalid\0/movie.mkv",
    ]) {
      assert.equal(ctx.sawRecordedPath(target), false)
      await assert.rejects(
        execute(tools, "anvil_job_lookup", {
          purpose: "Reject an unverified path",
          absolute_path: target,
        }),
        /evidence gate|exact absolute path/,
      )
    }
    await execute(tools, "anvil_job_lookup", {
      purpose: "Find the imported file's job",
      absolute_path: SOURCE_PATH,
    })
    await execute(tools, "anvil_job_show", {
      purpose: "Read failure details",
      job: "7",
    })
    await assert.rejects(
      execute(tools, "anvil_retry_job", {
        reason: "History paths must not grant retry permission",
        job: "7",
      }),
      /not uniquely returned by an exact-path lookup/,
    )
  })
}

async function execute(
  tools: ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool.execute("test", params, undefined, undefined, undefined as never)
}

async function fakeAnvilctl(
  options: {
    largeDiagnostics?: boolean
    showDelayMs?: number
    legacyShow?: boolean
    showExitCode?: number
  } = {},
): Promise<{
  command: string
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blitzcrank-anvil-test-"))
  const command = path.join(dir, "anvilctl")
  await writeFile(
    command,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
appendFileSync(process.argv[1] + ".calls", JSON.stringify(args) + "\\n")
const command = args.find((arg) => ["jobs", "show", "retry", "status"].includes(arg))
if (command === "show" && ${options.legacyShow === true} && !args.includes("job")) {
  process.stderr.write('unknown command "show"')
  process.exit(2)
}
if (command === "show" && ${options.showExitCode !== undefined}) {
  process.stderr.write("show failed")
  process.exit(${options.showExitCode ?? 0})
}
const stateFile = process.argv[1] + ".state"
const state = existsSync(stateFile) ? "pending" : "failed"
const job = {
  id: 7,
  slug: "steady-wrench",
  library: "usenet-tv",
  state,
  source: {
    path: "Show/episode.mkv",
    absolute_path: ${JSON.stringify(SOURCE_PATH)},
    generation: 1,
    current: true,
    status: "active"
  },
  destination_path: ${JSON.stringify(CONVERTED_PATH)},
  matched_on: ["source"]
}

if (command === "jobs") {
  process.stdout.write(JSON.stringify({
    api_version: "v1",
    matched: 1,
    truncated: false,
    jobs: [job]
  }))
} else if (command === "show") {
  await new Promise((resolve) => setTimeout(resolve, ${options.showDelayMs ?? 0}))
  process.stdout.write(JSON.stringify({
    api_version: "v1",
    job: {
      id: job.id,
      slug: job.slug,
      state,
      source_path: ${JSON.stringify(SOURCE_PATH)},
      asset_path: "",
      path: ${JSON.stringify(SOURCE_PATH)},
      last_error: state === "failed" ? "worker exited" : ""
    },
    attempts: [{
      id: 3,
      number: 1,
      state: state === "failed" ? "failed" : "canceled",
      error: state === "failed" ? "worker exited" : "",
      events: ${
        options.largeDiagnostics
          ? 'Array.from({ length: 20 }, (_, index) => ({ type: "block_failed", message: "x".repeat(1000) + index }))'
          : "[]"
      }
    }],
    publish_operation: {
      kind: "handoff",
      stage: "prepared",
      destination_path: ${JSON.stringify(CONVERTED_PATH)}
    }
  }))
} else if (command === "retry") {
  writeFileSync(stateFile, "pending")
  process.stdout.write(JSON.stringify({ api_version: "v1", jobs: [{ ...job, state: "pending" }] }))
} else if (command === "status") {
  process.stdout.write(JSON.stringify({ api_version: "v1", queue: {} }))
} else {
  process.stderr.write("unsupported test command")
  process.exit(2)
}
`,
  )
  await chmod(command, 0o700)
  return {
    command,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test("Anvil show falls back only for the exact legacy usage error", async (t) => {
  for (const options of [
    { legacyShow: true },
    { showExitCode: 2 },
    { showExitCode: 3 },
    { showExitCode: 4 },
  ]) {
    const fake = await fakeAnvilctl(options)
    t.after(fake.cleanup)
    const ctx = new RunContext()
    ctx.recordIdentity("anvil", 7)
    const tools = buildAnvilTools(
      { command: fake.command, socket: "/tmp/anvil.sock" },
      ctx,
    )
    const show = execute(tools, "anvil_job_show", {
      purpose: "diagnose known job",
      job: "7",
    })
    if (options.legacyShow) await show
    if (options.showExitCode) {
      const message =
        options.showExitCode === 3
          ? /Anvil is unreachable/
          : options.showExitCode === 4
            ? /Anvil has no such job/
            : /show failed/
      await assert.rejects(show, message)
    }
    const calls = (await readFile(fake.command + ".calls", "utf8"))
      .trim()
      .split("\n")
    assert.equal(calls.length, options.legacyShow ? 2 : 1)
  }
})

describe("Anvil lookup interpretation", () => {
  test("labels an empty lookup unknown instead of absent", () => {
    const result = interpretJobLookup(
      { api_version: "v1", matched: 0, jobs: [], truncated: false },
      SOURCE_PATH,
    )
    assert.equal(result.matched, 0)
    assert.match(String(result.conclusion), /UNKNOWN, not absence/)
    assert.equal(result.checked_path, SOURCE_PATH)
  })

  test("rejects an incomplete list contract", () => {
    const result = interpretJobLookup(
      { api_version: "v1", jobs: [], truncated: false },
      SOURCE_PATH,
    )
    assert.equal(result.output_complete, false)
    assert.match(String(result.conclusion), /INCOMPLETE LOOKUP/)
  })

  test("makes local and daemon truncation authoritative", () => {
    const result = interpretJobLookup(
      {
        api_version: "v1",
        jobs: [{ id: 7 }],
        truncated: true,
        output_complete: true,
      },
      SOURCE_PATH,
    )
    assert.equal(result.output_complete, false)
    assert.match(String(result.conclusion), /INCOMPLETE LOOKUP/)
  })
})

describe("Anvil retry gates", () => {
  test("requires exact correlation and visible diagnostics, then retries once", async (t) => {
    const fake = await fakeAnvilctl()
    t.after(fake.cleanup)
    const ctx = new RunContext()
    ctx.recordPath("sonarr", SOURCE_PATH, "outputPath")
    const tools = buildAnvilTools(
      { command: fake.command, socket: "/tmp/anvild.sock" },
      ctx,
    )

    await execute(tools, "anvil_job_lookup", {
      purpose: "correlate the stalled import",
      absolute_path: SOURCE_PATH,
    })
    await execute(tools, "anvil_job_show", {
      purpose: "diagnose the failed attempt",
      job: "7",
    })
    assert.equal(ctx.sawRecordedPath(CONVERTED_PATH), true)

    const retried = await execute(tools, "anvil_retry_job", {
      reason: "retry failed job 7 for the exact stalled episode",
      job: "7",
    })
    const content = retried.content[0]
    if (!content || content.type !== "text") {
      assert.fail("retry returned no text result")
    }
    const outcome = JSON.parse(content.text) as {
      verification: { job: { state: string } }
    }
    assert.equal(outcome.verification.job.state, "pending")

    await assert.rejects(
      execute(tools, "anvil_retry_job", {
        reason: "retry job 7 again",
        job: "7",
      }),
      /already retried this run/,
    )
  })

  test("reserves a concurrent retry before reading state", async (t) => {
    const fake = await fakeAnvilctl({ showDelayMs: 100 })
    t.after(fake.cleanup)
    const ctx = new RunContext()
    ctx.recordPath("sonarr", SOURCE_PATH, "outputPath")
    const tools = buildAnvilTools(
      { command: fake.command, socket: "/tmp/anvild.sock" },
      ctx,
    )

    await execute(tools, "anvil_job_lookup", {
      purpose: "correlate the stalled import",
      absolute_path: SOURCE_PATH,
    })
    await execute(tools, "anvil_job_show", {
      purpose: "diagnose the failed attempt",
      job: "7",
    })

    const retries = await Promise.allSettled([
      execute(tools, "anvil_retry_job", {
        reason: "retry failed job 7",
        job: "7",
      }),
      execute(tools, "anvil_retry_job", {
        reason: "concurrent duplicate retry for job 7",
        job: "7",
      }),
    ])
    assert.equal(
      retries.filter((result) => result.status === "fulfilled").length,
      1,
    )
    const rejected = retries.find((result) => result.status === "rejected")
    assert.ok(rejected)
    assert.match(String(rejected.reason), /already retried this run/)
  })

  test("omitted failure diagnostics block retry", async (t) => {
    const fake = await fakeAnvilctl({ largeDiagnostics: true })
    t.after(fake.cleanup)
    const ctx = new RunContext()
    ctx.recordPath("sonarr", SOURCE_PATH, "outputPath")
    const tools = buildAnvilTools(
      { command: fake.command, socket: "/tmp/anvild.sock" },
      ctx,
    )

    await execute(tools, "anvil_job_lookup", {
      purpose: "correlate the stalled import",
      absolute_path: SOURCE_PATH,
    })
    const shown = await execute(tools, "anvil_job_show", {
      purpose: "diagnose the failed attempt",
      job: "7",
    })
    const content = shown.content[0]
    if (!content || content.type !== "text") {
      assert.fail("show returned no text result")
    }
    assert.equal(
      (JSON.parse(content.text) as { output_complete: boolean })
        .output_complete,
      false,
    )
    await assert.rejects(
      execute(tools, "anvil_retry_job", {
        reason: "retry failed job 7",
        job: "7",
      }),
      /incomplete diagnostic history/,
    )
  })

  test("a broad list and show cannot authorize retry", async (t) => {
    const fake = await fakeAnvilctl()
    t.after(fake.cleanup)
    const tools = buildAnvilTools(
      { command: fake.command, socket: "/tmp/anvild.sock" },
      new RunContext(),
    )

    await execute(tools, "anvil_job_list", {
      purpose: "inspect failures",
      states: ["failed"],
    })
    await execute(tools, "anvil_job_show", {
      purpose: "diagnose the failed attempt",
      job: "7",
    })
    await assert.rejects(
      execute(tools, "anvil_retry_job", {
        reason: "retry job 7",
        job: "7",
      }),
      /not uniquely returned by an exact-path lookup/,
    )
  })
})

test("the automation read allowlist never includes Anvil retry", () => {
  for (const name of [
    "anvil_status",
    "anvil_job_list",
    "anvil_job_lookup",
    "anvil_job_show",
  ]) {
    assert.equal(isReadTool(name), true)
  }
  assert.equal(isReadTool("anvil_retry_job"), false)
})
