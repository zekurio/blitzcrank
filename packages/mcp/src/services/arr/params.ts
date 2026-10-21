import { Type, type TObject } from "typebox"

import { isNumber, type JsonObject } from "../../json.ts"
import type { Arr } from "./client.ts"

export const offsetParam = Type.Optional(
  Type.Integer({
    minimum: 0,
    description: "Skip this many entries when a result came back truncated",
  }),
)

/**
 * Adds the Arr's own item-id param. Its key differs per Arr, so the static
 * type of `params` leaves it out; read it with `itemIdOf`.
 */
export function withItemId<P extends TObject>(
  arr: Arr,
  params: P,
  description: string,
): P {
  // SAFETY: only widens the schema by one optional integer.
  return Type.Object({
    ...params.properties,
    [arr.itemKey]: Type.Optional(Type.Integer({ minimum: 1, description })),
  }) as unknown as P
}

export function itemIdOf(arr: Arr, params: object): number | undefined {
  // SAFETY: validated arguments are a JSON object.
  const value = (params as JsonObject)[arr.itemKey]
  return isNumber(value) ? value : undefined
}
