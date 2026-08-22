import type { AutomationDefinition } from "./definitions.ts"

/** Resolve a deployment-owned override without making it task frontmatter. */
export function modelSpecForAutomation(
  name: string,
  defaultModelSpec: string,
  modelSpecs: Readonly<Record<string, string>>,
): string {
  return Object.hasOwn(modelSpecs, name) ? modelSpecs[name]! : defaultModelSpec
}

/** A stale key is most likely a renamed/deleted automation, never dead config. */
export function assertKnownAutomationModels(
  definitions: ReadonlyArray<Pick<AutomationDefinition, "name">>,
  modelSpecs: Readonly<Record<string, string>>,
): void {
  const names = new Set(definitions.map((definition) => definition.name))
  for (const name of Object.keys(modelSpecs)) {
    if (!names.has(name)) {
      throw new Error(
        `BLITZCRANK_AUTOMATION_MODELS references unknown automation "${name}"`,
      )
    }
  }
}
