import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { interpretJobLookup } from "./anvil.js"
import { RunContext } from "./context.js"

describe("interpretJobLookup", () => {
  const path = "/mnt/downloads/complete/YAIBA.S01E01/f.mkv"

  test("labels an empty result unknown instead of absent", () => {
    const result = interpretJobLookup({ api_version: "v1", jobs: [] }, path)
    assert.equal(result.matched, 0)
    assert.match(String(result.conclusion), /UNKNOWN, not absence/)
    assert.match(String(result.next_step), /anvil_job_list/)
    assert.equal(result.checked_path, path)
  })

  test("passes a non-empty result through untouched", () => {
    const response = { api_version: "v1", jobs: [{ id: 167 }] }
    assert.deepEqual(interpretJobLookup(response, path), response)
  })

  test("a destination-path match is a real match, not a miss", () => {
    // Anvil resolves source, asset and destination paths and says which side
    // hit, so the converted file correlates to its job like any other path.
    const response = {
      api_version: "v1",
      jobs: [
        {
          id: 167,
          state: "running",
          matched_on: ["destination"],
          destination_path: "/mnt/downloads/converted/Show/e01.mkv",
        },
      ],
    }
    assert.deepEqual(
      interpretJobLookup(response, "/mnt/downloads/converted/Show/e01.mkv"),
      response,
    )
  })

  test("reads nested job arrays", () => {
    const result = interpretJobLookup(
      { api_version: "v1", data: { jobs: [] } },
      path,
    )
    assert.equal(result.matched, 0)
  })

  test("an unrecognized shape is unknown, never zero", () => {
    const result = interpretJobLookup({ api_version: "v1" }, path)
    assert.equal(result.matched, "unknown")
    assert.match(String(result.conclusion), /UNKNOWN/)
  })
})

describe("job evidence", () => {
  test("a probed converted path must come from a recorded anvil read", () => {
    const ctx = new RunContext()
    ctx.recordRead(
      "anvil",
      "job list --absolute-path /mnt/downloads/complete/Show/e01.mkv",
      JSON.stringify({
        api_version: "v1",
        jobs: [
          {
            id: 167,
            source: "/mnt/downloads/complete/Show/e01.mkv",
            destination: "/mnt/downloads/converted/Show/e01.mkv",
          },
        ],
      }),
    )
    assert.equal(
      ctx.sawPathInAnyRead("/mnt/downloads/converted/Show/e01.mkv"),
      true,
    )
  })

  test("anvil evidence cannot satisfy an Arr id gate", () => {
    const ctx = new RunContext()
    ctx.recordRead("anvil", "job list", JSON.stringify({ jobs: [{ id: 167 }] }))
    assert.throws(
      () => ctx.requireEvidence("sonarr", 167, "series id"),
      /did not appear in any sonarr read/,
    )
  })
})
