import { Effect } from "effect"
import { Type, type Static, type TObject } from "typebox"
import { Check, Errors } from "typebox/value"

import type { JsonObject } from "../json.ts"
import { ToolError, toolFail } from "./errors.ts"

/** A table entry's own schema, closed so a misspelt parameter is an error. */
export function strict(params: TObject): TObject {
  return Type.Object(params.properties, { additionalProperties: false })
}

export function checkParams(
  tool: string,
  schema: TObject,
  args: unknown,
): Effect.Effect<JsonObject, ToolError> {
  // SAFETY: the arguments arrived as JSON and passed the tool's schema.
  return checkArgs(tool, schema, args).pipe(
    Effect.map((params) => params as JsonObject),
  )
}

export function checkArgs<P extends TObject>(
  tool: string,
  schema: P,
  args: unknown,
): Effect.Effect<Static<P>, ToolError> {
  if (Check(schema, args)) return Effect.succeed(args)
  return toolFail(
    `invalid arguments for ${tool}: ${describeErrors(schema, args)}`,
  )
}

const MAX_REPORTED_ERRORS = 6

function describeErrors(schema: TObject, value: unknown): string {
  const lines = Errors(schema, value).flatMap((error) => {
    const path = error.instancePath.replace(/^\//, "").replaceAll("/", ".")
    const at = path ? `${path}: ` : ""
    if (error.keyword === "boolean" || error.schemaPath.includes("/anyOf/")) {
      return []
    }
    if (error.keyword === "additionalProperties") {
      return [
        `${at}unknown parameter ${error.params.additionalProperties.join(", ")}`,
      ]
    }
    if (error.keyword === "required") {
      return [
        `${at}missing required parameter ${error.params.requiredProperties.join(", ")}`,
      ]
    }
    if (error.keyword === "enum") {
      return [
        `${at}must be one of ${error.params.allowedValues.map(String).join(", ")}`,
      ]
    }
    return [`${at || "arguments: "}${error.message}`]
  })
  const unique = [...new Set(lines)]
  if (unique.length === 0) return "arguments do not match the schema"
  return unique.slice(0, MAX_REPORTED_ERRORS).join("; ")
}
