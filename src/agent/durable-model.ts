import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

const THINKING_LEVELS = /^(.*?):(off|minimal|low|medium|high|xhigh|max)$/
type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export interface ParsedModelSpec {
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
}

export function parseModelSpec(spec: string): ParsedModelSpec {
  const suffix = spec.match(THINKING_LEVELS)
  const base = suffix ? suffix[1]! : spec
  const slash = base.indexOf("/")
  if (slash === -1)
    throw new Error(`model must be "provider/model[:thinking]", got "${spec}"`)
  return {
    provider: base.slice(0, slash),
    modelId: base.slice(slash + 1),
    thinkingLevel: (suffix?.[2] as ThinkingLevel | undefined) ?? "medium",
  }
}

export function resolveModel(modelRuntime: ModelRuntime, spec: string) {
  const parsed = parseModelSpec(spec)
  const model = modelRuntime.getModel(parsed.provider, parsed.modelId)
  if (!model) throw new Error(`Unknown model: ${spec}`)
  return model
}

/** Guard entrypoints, not their internal calls, which bind to the original runtime. */
export function guardModelRequests(
  runtime: ModelRuntime,
  assertRunning: () => void,
): ModelRuntime {
  const requests = new Set([
    "stream",
    "complete",
    "streamSimple",
    "completeSimple",
    "streamDeferred",
    "fetchDeferred",
    "generateImages",
    "classify",
  ])
  return new Proxy(runtime, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== "function") return value
      if (typeof key !== "string" || !requests.has(key))
        return value.bind(target)
      return (...args: unknown[]) => {
        assertRunning()
        return Reflect.apply(value, target, args)
      }
    },
  })
}
