import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { emptyCase } from "../casefile.js"
import { buildCaseFileTool } from "./casefile.js"

/** The tool only uses toolCallId and params; the rest is session plumbing. */
const store = (file = emptyCase("9")) => {
  const tool = buildCaseFileTool(file)
  return {
    file,
    call: (params: Parameters<typeof tool.execute>[1]) =>
      tool.execute("call-1", params, undefined, undefined, undefined as never),
  }
}

describe("update_case_file", () => {
  test("stores what the run established", async () => {
    const { file, call } = store()
    await call({
      hypothesis: "no German dub exists yet",
      facts: ["series 483; 24 files, all jpn (media_probe)"],
      ruledOut: ["lost during conversion"],
      openQuestions: ["German release date"],
    })
    assert.equal(file.summary.hypothesis, "no German dub exists yet")
    assert.deepEqual(file.summary.facts, [
      "series 483; 24 files, all jpn (media_probe)",
    ])
    assert.deepEqual(file.summary.ruledOut, ["lost during conversion"])
  })

  test("replaces the previous summary instead of appending", async () => {
    const { file, call } = store()
    file.summary.facts = ["stale fact"]
    await call({ facts: ["current fact"] })
    assert.deepEqual(file.summary.facts, ["current fact"])
    assert.deepEqual(file.summary.ruledOut, [])
    assert.equal(file.summary.hypothesis, undefined)
  })

  test("caps what the model can write into the next run's prompt", async () => {
    const { file, call } = store()
    const result = await call({
      hypothesis: "h".repeat(1000),
      facts: Array.from({ length: 40 }, (_, i) => `fact ${i} `.repeat(200)),
    })
    assert.equal(file.summary.hypothesis?.length, 300)
    assert.equal(file.summary.facts.length, 12)
    assert.ok(file.summary.facts.every((fact) => fact.length <= 300))
    const text = result.content[0]
    assert.match(text?.type === "text" ? text.text : "", /"facts": 12/)
  })

  test("an empty hypothesis is dropped, not stored blank", async () => {
    const { file, call } = store()
    await call({ hypothesis: "   ", facts: [] })
    assert.equal(file.summary.hypothesis, undefined)
  })
})
