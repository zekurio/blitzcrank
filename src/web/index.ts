import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

import type { WebConfig } from "../config.ts"
import { buildFirecrawlTools } from "./firecrawl.ts"

export interface WebProvider {
  tools: ToolDefinition[]
  /** Registered tool names, so prompts can track capabilities exactly. */
  searchTool: string | undefined
  extractTool: string | undefined
}

/**
 * Web tools for one run. The provider is rebuilt per run, which is what makes
 * the search→extract URL gate per-run: each new tool set starts with an empty
 * set of extractable URLs.
 */
export function buildWebProvider(config: WebConfig): WebProvider {
  if (config.provider === "firecrawl") {
    return {
      tools: buildFirecrawlTools(config),
      searchTool: "web_search",
      extractTool: "web_extract",
    }
  }
  return { tools: [], searchTool: undefined, extractTool: undefined }
}
