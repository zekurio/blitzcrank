import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { assertAnvilSourcePath, interpretJobLookup } from "./anvil.js"

describe("assertAnvilSourcePath", () => {
  const roots = ["/mnt/downloads/converted"]

  test("accepts a source path", () => {
    assertAnvilSourcePath("/mnt/downloads/complete/YAIBA.S01E01/f.mkv", roots)
  })

  test("rejects a converted destination path with the reason", () => {
    assert.throws(
      () =>
        assertAnvilSourcePath(
          "/mnt/downloads/converted/YAIBA.S01E01/f.mkv",
          roots,
        ),
      /indexes jobs by their source path/,
    )
  })

  test("rejects the destination root itself", () => {
    assert.throws(
      () => assertAnvilSourcePath("/mnt/downloads/converted", roots),
      /Anvil output root/,
    )
  })

  test("does not reject a sibling that merely shares the prefix", () => {
    assertAnvilSourcePath("/mnt/downloads/converted-backup/f.mkv", roots)
  })

  test("accepts everything when no output roots are configured", () => {
    assertAnvilSourcePath("/mnt/downloads/converted/f.mkv", [])
  })
})

describe("interpretJobLookup", () => {
  const path = "/mnt/downloads/complete/YAIBA.S01E01/f.mkv"

  test("labels an empty result unknown instead of absent", () => {
    const result = interpretJobLookup({ api_version: "v1", jobs: [] }, path)
    assert.equal(result.matched, 0)
    assert.match(String(result.conclusion), /UNKNOWN, not absence/)
    assert.match(String(result.next_step), /anvil_job_list/)
    assert.equal(result.checked_source_path, path)
  })

  test("passes a non-empty result through untouched", () => {
    const response = { api_version: "v1", jobs: [{ id: 167 }] }
    assert.deepEqual(interpretJobLookup(response, path), response)
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
