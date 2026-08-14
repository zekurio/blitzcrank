# Pi SDK: headless Node integration guide

Research date: 2026-08-14. Installed/published version inspected: **0.84.2**.

## Recommendation

For a headless service, use the high-level SDK in **`@earendil-works/pi-coding-agent`**. It exposes `createAgentSession()`, resource/skill loading, model authentication, custom tools, events, and session persistence without requiring the TUI.

```bash
pnpm add @earendil-works/pi-coding-agent@0.84.2 \
  @earendil-works/pi-ai@0.84.2 \
  typebox@1.1.38
```

`@earendil-works/pi-coding-agent@0.84.2` already depends on `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `typebox`. Declare `@earendil-works/pi-ai` and `typebox` directly because application code below imports them directly. Install `@earendil-works/pi-agent-core@0.84.2` directly only if application code imports its low-level `Agent` or types.

Confirmed with npm:

- `@earendil-works/pi-coding-agent`: `0.84.2`
- `@earendil-works/pi-agent-core`: `0.84.2`
- `@earendil-works/pi-ai`: `0.84.2`

### 0.84 upgrade check

Version 0.84.0 changed `message_update` events to expose deltas through
`assistantMessageEvent`. Blitzcrank already uses that form. It does not use the
changed provider refresh APIs or the removed low-level session repository APIs.
The 0.84.2 type check therefore needs no SDK call-site migration.

Blitzcrank pins `pi-codex-search@0.1.6`. The runner loads its declared extension
path only for issue runs while `noExtensions` stays enabled. The explicit tool
allowlist includes `codex_search`; automations do not load or allow it. The
extension reads the service's existing `openai-codex` OAuth credential and
sends a separate hosted web-search request. Its `high` setting controls search
context size, not model reasoning effort. Headless SDK sessions must call
`session.bindExtensions()` so extension `session_start` handlers can register
their tools before the first prompt.

Important import paths at this version:

```ts
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"

// The installed SDK examples use /compat for model lookup.
import { getModel } from "@earendil-works/pi-ai/compat"
import { StringEnum } from "@earendil-works/pi-ai"
import { Type } from "typebox"

// Only when using the lower-level agent API directly:
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core"
```

## Minimal headless session

```ts
import { getModel } from "@earendil-works/pi-ai/compat"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"

const cwd = process.cwd()

const modelRuntime = await ModelRuntime.create()
const model = getModel("anthropic", "claude-sonnet-4-5")
if (!model) throw new Error("Model not found")

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: `${process.env.HOME}/.pi/agent`,
  systemPromptOverride: () => "You are a concise service agent.",
  // Prevent APPEND_SYSTEM.md discovery from adding further instructions.
  appendSystemPromptOverride: () => [],
})
await loader.reload()

const { session } = await createAgentSession({
  cwd,
  model,
  thinkingLevel: "off",
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
  }),
})

try {
  await session.prompt("Reply with one sentence.")
} finally {
  session.dispose()
}
```

`createAgentSession()` can select a model automatically from a restored session, settings, or the first authenticated model, but a service should normally select one explicitly for predictable behavior.

Supported `thinkingLevel` values in the declarations are `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, and `"max"`; model capabilities may clamp the requested value.

## Model providers and API keys

`ModelRuntime` is the high-level model/authentication API:

```ts
const modelRuntime = await ModelRuntime.create()

// Includes built-in models and models.json custom providers.
const configured = modelRuntime.getModel("my-provider", "my-model")

// Only models for which valid authentication is available.
const available = await modelRuntime.getAvailable()

// Ephemeral override; not persisted.
modelRuntime.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY!)
```

Authentication resolution order documented by pi is:

1. `setRuntimeApiKey()` overrides
2. stored credentials in `auth.json`
3. provider environment variables, such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`
4. custom-provider fallback resolution from `models.json`

For a service that must not read a developer's home directory, use custom paths or an in-memory credential store:

```ts
import { InMemoryCredentialStore } from "@earendil-works/pi-ai"

const credentials = new InMemoryCredentialStore()
const modelRuntime = await ModelRuntime.create({ credentials })
modelRuntime.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY!)
```

Alternatively:

```ts
const modelRuntime = await ModelRuntime.create({
  authPath: "/var/lib/my-service/pi/auth.json",
  modelsPath: "/etc/my-service/pi/models.json",
})
```

## Custom tools

Pi uses **TypeBox**, via the package named `typebox`—not Zod—for tool parameter schemas. Use `defineTool()` to preserve `params` inference when storing tools in variables or arrays.

```ts
import { Type } from "typebox"
import { defineTool } from "@earendil-works/pi-coding-agent"

const lookupUser = defineTool({
  name: "lookup_user",
  label: "Lookup user",
  description: "Look up a user by numeric ID",
  parameters: Type.Object({
    id: Type.Integer({ minimum: 1 }),
  }),
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) throw new Error("Lookup cancelled")

    onUpdate?.({
      content: [{ type: "text", text: "Looking up user..." }],
      details: { stage: "lookup" },
    })

    const user = await findUser(params.id, { signal })
    if (!user) throw new Error(`User ${params.id} not found`)

    return {
      // Text/image content is sent back to the model.
      content: [{ type: "text", text: JSON.stringify(user) }],
      // Arbitrary structured data for logging/rendering/state.
      details: { user },
    }
  },
})
```

Register it directly on the session:

```ts
const { session } = await createAgentSession({
  customTools: [lookupUser],
  noTools: "builtin", // custom/extension tools remain enabled
  sessionManager: SessionManager.inMemory(),
})
```

Or use an explicit allowlist:

```ts
const { session } = await createAgentSession({
  customTools: [lookupUser],
  tools: ["lookup_user"],
})
```

Tool results have this effective shape from `AgentToolResult<T>`:

```ts
{
  content: Array<TextContent | ImageContent>;
  details: T;
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}
```

### Tool errors

**Throw from `execute()` to report a failed tool call.** Pi catches the exception, emits a result with `isError: true`, reports it to the model, and continues the agent loop. Returning `{ isError: true }` does not work because `isError` is not a tool return field.

Use `StringEnum` from `@earendil-works/pi-ai` instead of `Type.Union(Type.Literal(...))` for string enums that must work with Google's API:

```ts
parameters: Type.Object({
  action: StringEnum(["list", "add"] as const),
})
```

Tool calls execute in parallel by default. File-mutating custom tools should use exported `withFileMutationQueue(absolutePath, fn)` around the entire read-modify-write operation to avoid races with built-in `edit`/`write`.

## Run one prompt and obtain the final answer

`await session.prompt(text)` waits until the accepted run has completed, including tool calls and retries. It returns `void`; read the transcript afterward.

```ts
import type { AssistantMessage } from "@earendil-works/pi-ai"

await session.prompt("Summarize the account status.")

const lastAssistant = [...session.messages]
  .reverse()
  .find((m): m is AssistantMessage => m.role === "assistant")

if (!lastAssistant) throw new Error("Agent produced no assistant message")
if (lastAssistant.stopReason === "error") {
  throw new Error(lastAssistant.errorMessage ?? "Model request failed")
}

const finalText = lastAssistant.content
  .filter((block) => block.type === "text")
  .map((block) => block.text)
  .join("")
```

The examples also access `session.state.messages`; the public documentation emphasizes `session.messages` and `session.agent.state.messages`. Prefer `session.messages` unless a particular installed declaration requires otherwise.

### Event logging and streaming

```ts
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta)
      }
      break

    case "tool_execution_start":
      logger.info(
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        },
        "tool started",
      )
      break

    case "tool_execution_update":
      logger.debug({ partialResult: event.partialResult }, "tool update")
      break

    case "tool_execution_end":
      logger.info(
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        },
        "tool finished",
      )
      break

    case "message_end":
      logger.debug({ message: event.message }, "message finished")
      break

    case "agent_end":
      logger.info({ messages: event.messages }, "agent finished")
      break
  }
})

try {
  await session.prompt("Do the work.")
} finally {
  unsubscribe()
  session.dispose()
}
```

## Skills in SDK mode

Skills are **not CLI-only**. `DefaultResourceLoader` loads them for SDK-created sessions, and `AgentSession.prompt()` handles skill command expansion. The SDK example `04-skills.ts` explicitly creates an SDK session with filtered/custom skills.

A normal skill directory is:

```text
my-skill/
├── SKILL.md
├── scripts/
│   └── process.sh
├── references/
│   └── api-reference.md
└── assets/
    └── template.json
```

`SKILL.md`:

````md
---
name: my-skill
description: Processes account exports. Use when validating or transforming account export files.
license: MIT
compatibility: Requires Node.js and access to the account API.
metadata:
  owner: platform
allowed-tools: read bash
disable-model-invocation: false
---

# Account export processing

Read [references/api-reference.md](references/api-reference.md), then run:

```bash
./scripts/process.sh <input>
```
````

Required frontmatter:

- `name`: 1–64 characters, lowercase letters/numbers/hyphens, no leading/trailing or consecutive hyphens
- `description`: required, maximum 1024 characters; missing descriptions prevent loading

Optional fields documented by pi: `license`, `compatibility`, `metadata`, `allowed-tools`, and `disable-model-invocation`. Unknown fields are ignored. Most validation failures are warnings; duplicate names keep the first discovered skill.

### Pointing the SDK at a custom skills directory

Use `additionalSkillPaths`:

```ts
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  additionalSkillPaths: ["/opt/my-service/skills"],
  // Set true if only the explicit paths should load.
  noSkills: true,
})
await loader.reload()

const { skills, diagnostics } = loader.getSkills()
for (const diagnostic of diagnostics) console.warn(diagnostic.message)

const { session } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
})
```

The docs state that explicit CLI `--skill` paths remain additive with `--no-skills`. For the SDK, the declaration exposes `additionalSkillPaths` and `noSkills`, but does not explicitly document their interaction. Verify whether `noSkills: true` plus `additionalSkillPaths` remains additive for the exact release before relying on that combination; otherwise use `skillsOverride`, or load only the desired skills into a custom `ResourceLoader`.

A deterministic override is:

```ts
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  additionalSkillPaths: ["/opt/my-service/skills"],
  skillsOverride: (current) => ({
    skills: current.skills.filter((skill) =>
      skill.filePath.startsWith("/opt/my-service/skills/"),
    ),
    diagnostics: current.diagnostics,
  }),
})
await loader.reload()
```

### Progressive disclosure caveat

At startup, skill names/descriptions are included in the system prompt. For automatic use, the model is expected to call the **`read` tool** to load the selected `SKILL.md`. Therefore, if all built-in tools are disabled and no equivalent custom file-reading tool exists, the model can see that a skill exists but cannot automatically load its full instructions.

Skill commands are named `/skill:<name>`. `AgentSession.prompt()` supports command expansion, so a service may explicitly call:

```ts
await session.prompt("/skill:my-skill input arguments")
```

Skill command availability is controlled by `enableSkillCommands` in settings. `disable-model-invocation: true` hides a skill from the system prompt and leaves it available only through explicit `/skill:name` invocation.

## Session persistence

### Ephemeral/in-memory

```ts
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(cwd),
})
```

No session file is written; `session.sessionFile` is `undefined`.

### Persistent JSONL session files

```ts
// New persistent session in pi's cwd-derived session directory.
SessionManager.create(cwd)

// New persistent session in a custom directory.
SessionManager.create(cwd, "/var/lib/my-service/pi-sessions")

// Continue the most recent session, creating one if necessary.
SessionManager.continueRecent(cwd, "/var/lib/my-service/pi-sessions")

// Open an exact session file.
SessionManager.open("/var/lib/my-service/pi-sessions/session.jsonl")

// Discover sessions.
await SessionManager.list(cwd, "/var/lib/my-service/pi-sessions")
await SessionManager.listAll(cwd)
```

For replacing the active session at runtime (`newSession()`, `switchSession()`, `fork()`, imports), use `createAgentSessionRuntime()`/`AgentSessionRuntime`. `runtime.session` changes after replacement, so unsubscribe from the old session and subscribe again; extension bindings must also be rebound.

## Headless-service gotchas

### Node and modules

- `@earendil-works/pi-coding-agent@0.84.2` declares **Node.js `>=22.19.0`**.
- The package is ESM (`"type": "module"`) and only declares an `import` export. Use ESM TypeScript/JavaScript (`"type": "module"`, `module: "NodeNext"`/`"Node16"`, or equivalent). Do not assume `require()`/CommonJS support.
- Extensions are loaded through `jiti`, so extension `.ts` files can be loaded without separately compiling them, but the host service itself should use its normal TypeScript build/runtime setup.

### Working directory

The SDK defaults `cwd` to `process.cwd()`. It affects:

- built-in tool path resolution
- project extension/skill/prompt/context discovery
- walking ancestor directories for `.agents/skills` and `AGENTS.md`
- project settings
- session directory naming

Set an explicit, validated absolute `cwd` in a long-running service. `SessionManager.inMemory(cwd)` should use the same cwd. If using `DefaultResourceLoader`, pass the same `cwd` and `agentDir` there too.

### Disable coding tools

```ts
// Disable every tool, including custom and extension tools.
{ noTools: "all" }

// Disable default read/bash/edit/write, retaining custom/extension tools.
{ noTools: "builtin", customTools: [lookupUser] }

// Most deterministic: allow only named custom tools.
{ tools: ["lookup_user"], customTools: [lookupUser] }
```

`excludeTools` is a denylist applied after `tools`. If `tools` is supplied, custom/extension tool names must be included explicitly.

### Avoid accidental home/project discovery

The minimal `createAgentSession()` call performs default discovery. A locked-down service should construct `DefaultResourceLoader` with explicit directories and appropriate `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and `noContextFiles` options, or implement the `ResourceLoader` interface as shown in `examples/sdk/12-full-control.ts`.

Project-local resources may involve pi's project-trust behavior. For fully controlled service deployments, avoid dynamic project discovery and provide explicit resources.

### Cleanup and concurrency

- Call `session.dispose()` in `finally`.
- One `AgentSession` is stateful. Do not share a conversation session across unrelated requests.
- Calling `prompt()` while the session is streaming requires `streamingBehavior: "steer" | "followUp"`; otherwise it throws.
- `prompt()` completing means the run and retries have completed. The lower-level `Agent.waitForIdle()` is also available as `session.agent.waitForIdle()`.
- Extension code that calls TUI-only APIs must check `ctx.mode === "tui"`; UI-capable extension APIs should check `ctx.hasUI`. Plain custom tool definitions should avoid UI dependencies in headless mode.

## Suggested service factory

```ts
import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import { getModel } from "@earendil-works/pi-ai/compat"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"

export async function createServiceAgent(options: {
  cwd: string
  tools: ToolDefinition[]
}) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
  })
  modelRuntime.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY!)

  const model = getModel("anthropic", "claude-sonnet-4-5")
  if (!model) throw new Error("Configured model is unavailable in the catalog")

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: "/var/empty/pi-agent",
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () =>
      "You are a service agent. Use only the provided tools.",
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()

  return createAgentSession({
    cwd: options.cwd,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader: loader,
    customTools: options.tools,
    noTools: "builtin",
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    }),
  })
}
```

For maximum determinism, use `tools: options.tools.map(t => t.name)` rather than `noTools: "builtin"` if extensions might ever be enabled.

## Sources inspected

- Installed `docs/sdk.md`, read completely
- Installed `docs/skills.md`, read completely
- Relevant custom-tool, error, resource, and mode sections of `docs/extensions.md`
- Every file under installed `examples/sdk/`
- All top-level `dist/*.d.ts` files in installed `@earendil-works/pi-agent-core`, including `index.d.ts`, `agent.d.ts`, and `types.d.ts`
- Relevant coding-agent declarations for SDK options, resources, skills, tools, and agent sessions
- Installed package metadata and live `npm view` package versions
