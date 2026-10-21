import { Effect } from "effect"
import type { Static, TObject } from "typebox"

import type { JsonObject } from "../json.ts"
import type { ToolFailure } from "./errors.ts"
import { checkParams, strict } from "./params.ts"
import { jsonResult } from "./results.ts"
import {
  sentence,
  withDeadline,
  type ServerTool,
  type Service,
} from "./tool.ts"

/** The host gives one tool call 180 s, so a read has to answer first. */
const READ_DEADLINE_MS = 150_000

export interface ResourceSpec<P extends TObject> {
  description: string
  params: P
  run: (
    params: Static<P>,
    signal: AbortSignal,
  ) => Effect.Effect<JsonObject, ToolFailure>
}

export interface Resource {
  description: string
  params: TObject
  run: (
    params: JsonObject,
    signal: AbortSignal,
  ) => Effect.Effect<JsonObject, ToolFailure>
}

export function resource<P extends TObject>(spec: ResourceSpec<P>): Resource {
  return {
    description: spec.description,
    params: spec.params,
    // SAFETY: the tool checks the arguments against `params` first.
    run: (params, signal) => spec.run(params as Static<P>, signal),
  }
}

/** One read-only tool per table entry, named `<service>_<entry>`. */
export function defineReads(
  service: Service,
  resources: Record<string, Resource>,
): ServerTool[] {
  return Object.entries(resources).map(([entry, spec]) => {
    const name = `${service.name}_${entry}`
    const schema = strict(spec.params)
    return {
      name,
      description: `${service.label} read. ${sentence(spec.description)}`,
      inputSchema: { ...schema, type: "object" },
      annotations: { readOnlyHint: true },
      execute: (args, signal) =>
        checkParams(name, schema, args).pipe(
          Effect.flatMap((params) => spec.run(params, signal)),
          Effect.map(jsonResult),
          withDeadline(name, READ_DEADLINE_MS),
        ),
    }
  })
}
