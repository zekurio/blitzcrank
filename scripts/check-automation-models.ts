import assert from "node:assert/strict"

import { loadAutomations } from "../src/automations/definitions.js"
import {
  assertKnownAutomationModels,
  modelSpecForAutomation,
} from "../src/automations/models.js"
import { parseAutomationModels } from "../src/config.js"

assert.deepEqual(parseAutomationModels(undefined), {})
assert.deepEqual(parseAutomationModels("  "), {})
assert.deepEqual(
  parseAutomationModels(
    '{"stale-import-handler":"openai-codex/gpt-5.6-terra:high"}',
  ),
  {
    "stale-import-handler": "openai-codex/gpt-5.6-terra:high",
  },
)

for (const invalid of ["[]", "null", '"model"', "{", '{"task":3}']) {
  assert.throws(() => parseAutomationModels(invalid))
}

const definitions = [{ name: "stale-import-handler" }]
const models = {
  "stale-import-handler": "openai-codex/gpt-5.6-terra:high",
}
assertKnownAutomationModels(definitions, models)
assert.equal(
  modelSpecForAutomation("stale-import-handler", "provider/default", models),
  "openai-codex/gpt-5.6-terra:high",
)
assert.equal(
  modelSpecForAutomation("another-task", "provider/default", models),
  "provider/default",
)
assert.equal(
  modelSpecForAutomation("constructor", "provider/default", {}),
  "provider/default",
)
assert.throws(() =>
  assertKnownAutomationModels(definitions, { renamed: "provider/model" }),
)

const bundled = await loadAutomations("automations")
assert.ok(
  bundled.some((definition) => definition.name === "stale-import-handler"),
)

console.log("automation model configuration is valid")
