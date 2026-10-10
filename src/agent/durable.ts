import { createHash } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"

import { copyJson, type JsonValue } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation"
import {
  AssistantEntry,
  createRegistry,
  defineDocFamily,
  defineExtension,
  GenerationTask,
  Harness,
  hook,
  MemoryStorage,
  ToolTask,
  type EntryId,
  type HookApi,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite"
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node"
import { createReadTool } from "@earendil-works/pi-durable/tools"

import { HttpError } from "../services/http.ts"
import { ToolError, type HostTool } from "../tools/common.ts"
import type { DurableRunContext } from "../tools/context.ts"
import {
  guardModelRequests,
  parseModelSpec,
  resolveModel,
} from "./durable-model.ts"
import type {
  AgentTurnOptions,
  AgentTurnResult,
  DurableTurnFailure,
  RunUsage,
} from "./session.ts"

const context = BACKGROUND_CONTEXT

/** Text answers that get sent back to call the finish tool before giving up. */
const MAX_FINISH_NUDGES = 2

/** Host documents are not registered as agent-writable tools. */
export const DurableRunDoc = defineDocFamily({
  kind: "blitzcrank.run",
  version: 1,
  scope: "session",
  family: true,
  initial: (policy: string) => ({
    policy,
    evidence: "",
    hostState: "",
    apiPricing: null as boolean | null,
    usage: "",
    usageBaseline: "",
    operations: {} as Record<
      string,
      { name: string; callId: string; unsafe: boolean; result: string | null }
    >,
    failure: "",
  }),
})

export async function openDurableStorage(file: string | undefined) {
  if (file === undefined) return new MemoryStorage()
  await mkdir(path.dirname(file), { recursive: true })
  const database = await openNodeSqliteDatabase(file)
  await database.exec("PRAGMA synchronous = FULL")
  return SqliteStorage.open(database)
}

export function durablePolicyFingerprint(
  opts: Pick<AgentTurnOptions, "modelSpec" | "systemPrompt" | "prompt">,
  tools: readonly ToolRegistration[],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model: opts.modelSpec,
        systemPrompt: opts.systemPrompt,
        prompt: opts.prompt,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          replay: tool.replay ?? "unsafe",
        })),
      }),
    )
    .digest("hex")
}

/** Native intents/results decide replay; uncertain writes stop model continuation. */
export async function runDurableTurn(
  opts: AgentTurnOptions & { skillsDir: string },
): Promise<AgentTurnResult> {
  const registry = createRegistry()
  const nativeRead = createReadTool()
  const read = {
    ...nativeRead,
    replay: "safe" as const,
    async execute(
      args: Parameters<typeof nativeRead.execute>[0],
      api: Parameters<typeof nativeRead.execute>[1],
      invocation: Parameters<typeof nativeRead.execute>[2],
    ) {
      const root = await realpath(opts.skillsDir)
      const target = await realpath(path.resolve(root, args.path as string))
      if (!target.startsWith(`${root}${path.sep}`))
        throw new Error("read is restricted to deployment skills")
      return nativeRead.execute({ ...args, path: target }, api, invocation)
    },
  }
  const tools = [...opts.tools, ...(opts.builtinRead === false ? [] : [read])]
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
    throw new Error("duplicate trusted tool registration")
  const finishTool = tools.find((tool) => tool.name === opts.finishTool)
  if (opts.finishTool !== undefined && !finishTool)
    throw new Error(`finish tool ${opts.finishTool} is not registered`)
  // In memory: a restart may allow a few more nudges, never an unbounded loop.
  let nudges = 0
  const policy = durablePolicyFingerprint(opts, tools)
  const storage = await openDurableStorage(opts.storageFile)
  let harness: Harness | undefined
  let stopping = opts.signal?.aborted ?? false
  let active = 0
  let releaseActive: (() => void) | undefined
  let stopPromise: Promise<void> | undefined
  let stopError: unknown
  let failure: DurableTurnFailure | undefined
  const runSnapshot = () =>
    harness!.snapshot(DurableRunDoc, opts.requestId, context)

  // Durable reports hook exceptions and may still send the request. Enforce
  // the stop at the actual provider boundary, not only in beforeRequest.
  const models = guardModelRequests(opts.modelRuntime, () => {
    if (failure || stopping)
      throw new Error(failure?.message ?? "Durable run stopped")
  })

  async function gate(api: HookApi | ToolExecutionApi, toolName?: string) {
    const state = await runSnapshot()
    if (stopping) return "Run stopped"
    if (failure || state?.failure) return "Run requires operator review"
    if (state?.policy !== policy) return "Durable policy changed"
    const uncertain = Object.values(state.operations).filter(
      (operation) => operation.unsafe && operation.result === null,
    )
    if (uncertain.length > 0) {
      failure = {
        kind: "unsafe-interrupted",
        message: "A prior write may have run. Operator review is required.",
        toolNames: uncertain.map((operation) => operation.name),
      }
      return failure.message
    }
    const task = await harness!.getTask(api.taskId, context)
    const assistant =
      task &&
      task.input !== null &&
      typeof task.input === "object" &&
      !Array.isArray(task.input) &&
      typeof task.input.assistant === "number"
        ? await storage.entry(task.input.assistant as EntryId, context)
        : undefined
    const message = assistant?.entry.model?.[0]
    if (message?.role !== "assistant") return "Missing tool-round authority"
    // Durable terminates only when every call of the round asks to.
    if (
      toolName !== undefined &&
      toolName === finishTool?.name &&
      message.content.filter((block) => block.type === "toolCall").length > 1
    )
      return `${toolName} must be the only tool call in its response`
    return undefined
  }

  async function execute(
    tool: HostTool,
    args: Parameters<ToolRegistration["execute"]>[0],
    api: ToolExecutionApi,
    invocation: Parameters<ToolRegistration["execute"]>[2],
  ) {
    const blocked = await gate(api)
    if (blocked) throw new Error(blocked)
    const prior = (await runSnapshot())?.operations[String(api.taskId)]
    if (prior?.result !== null && prior?.result !== undefined)
      return JSON.parse(prior.result) as ToolExecutionResult
    if (prior?.unsafe)
      throw new Error("Uncertain prior write requires operator review")
    if (stopping) throw new Error("Run stopped")
    active += 1
    let checkpointed = false
    const beforeCounts = opts.runContext?.counts
    try {
      await api.commit(async (tx) => {
        const run = await tx.doc(DurableRunDoc, opts.requestId, policy)
        run.operations[String(api.taskId)] = {
          name: tool.name,
          callId: api.callId,
          unsafe: tool.replay !== "safe" || tool.writes?.(args) === true,
          result: null,
        }
      }, context)
      // The host does not cancel the invocation until write and read-back end.
      const result: ToolExecutionResult = await tool
        .execute(args, api, invocation)
        .then(undefined, (cause: unknown) => {
          // The service answered, so nothing is uncertain: hand the error to
          // the model. A gateway 502/504 is the proxy talking, not the service.
          if (
            cause instanceof HttpError &&
            cause.status !== 502 &&
            cause.status !== 504
          )
            return errorResult(cause.message)
          // A guard refused before anything was written.
          const afterCounts = opts.runContext?.counts
          if (
            cause instanceof ToolError &&
            beforeCounts !== undefined &&
            afterCounts?.mutations === beforeCounts.mutations &&
            afterCounts.deletes === beforeCounts.deletes
          )
            return errorResult(cause.message)
          throw cause
        })
      await api.commit(async (tx) => {
        const run = await tx.doc(DurableRunDoc, opts.requestId, policy)
        run.operations[String(api.taskId)]!.result = JSON.stringify(
          copyJson(result as JsonValue, { omitUndefinedProperties: true }),
        )
        if (opts.runContext)
          run.evidence = JSON.stringify(opts.runContext.durableSnapshot)
        if (opts.hostState)
          run.hostState = JSON.stringify(opts.hostState.capture())
        if (failure) run.failure = JSON.stringify(failure)
      }, context)
      checkpointed = true
      return result
    } finally {
      try {
        if (!checkpointed)
          await api.commit(async (tx) => {
            const run = await tx.doc(DurableRunDoc, opts.requestId, policy)
            if (opts.runContext)
              run.evidence = JSON.stringify(opts.runContext.durableSnapshot)
            if (opts.hostState)
              run.hostState = JSON.stringify(opts.hostState.capture())
          }, context)
      } finally {
        active -= 1
        if (active === 0) releaseActive?.()
      }
    }
  }

  const extension = defineExtension({
    name: "blitzcrank",
    tools: tools.map((tool) => ({
      ...tool,
      execute: (args, api, invocation) => execute(tool, args, api, invocation),
    })),
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          const block = await gate(api, call.name)
          return block ? { block } : undefined
        },
      }),
      hook(GenerationTask, {
        beforeRequest: async () => {
          const state = await runSnapshot()
          const uncertain = Object.values(state?.operations ?? {}).filter(
            (operation) => operation.unsafe && operation.result === null,
          )
          if (uncertain.length > 0)
            failure = {
              kind: "unsafe-interrupted",
              message:
                "A prior write may have run. Operator review is required.",
              toolNames: uncertain.map((operation) => operation.name),
            }
          if (failure || state?.policy !== policy || stopping)
            throw new Error(failure?.message ?? "Durable run stopped")
          return undefined
        },
        onYield: () => {
          if (!finishTool || failure || stopping) return undefined
          if (nudges >= MAX_FINISH_NUDGES) return undefined
          nudges += 1
          return {
            continue: `Plain text is never posted. End the run by calling \`${finishTool.name}\` as the only tool call.`,
          }
        },
      }),
    ],
  })
  registry.install(extension)

  try {
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          toolExecution: "sequential",
          // No background task may outlive this submission's Harness.
          compaction: { enabled: true, backgroundTokens: 0 },
        },
        env: () => new NodeExecutionEnv({ cwd: opts.skillsDir }),
      },
      context,
    )
    const conversation = await harness.root(context)
    const existing = await storage.submissionByRequest(
      conversation.id,
      opts.requestId,
      context,
    )
    const prior = await runSnapshot()
    const auth =
      prior?.apiPricing === null || !prior
        ? await opts.modelRuntime.checkAuth(
            parseModelSpec(opts.modelSpec).provider,
          )
        : undefined
    if (prior?.evidence && opts.runContext)
      opts.runContext.restoreDurable(
        JSON.parse(prior.evidence) as DurableRunContext,
      )
    if (prior?.hostState && opts.hostState)
      opts.hostState.restore(JSON.parse(prior.hostState) as JsonValue)
    const inspected = await harness.inspect(context)
    if (inspected.tasks.length > 0) {
      if (!prior || prior.policy !== policy)
        failure = {
          kind: "policy-changed",
          message: "Pending durable work has a different execution policy.",
          toolNames: [],
        }
      const unsafe = inspected.tasks.filter(
        (task) =>
          task.record.kind === ToolTask.definition.name &&
          task.record.state.status !== "terminal" &&
          task.record.state.status !== "completing" &&
          task.record.state.checkpoint !== null &&
          typeof task.record.state.checkpoint === "object" &&
          !Array.isArray(task.record.state.checkpoint) &&
          task.record.state.checkpoint.replay === "unsafe",
      )
      if (unsafe.length > 0)
        failure = {
          kind: "unsafe-interrupted",
          message:
            "An interrupted tool may have written. Operator review is required.",
          toolNames: Object.values(prior?.operations ?? {})
            .filter((operation) => operation.unsafe)
            .map((operation) => operation.name),
        }
    }
    if (prior?.failure)
      failure = JSON.parse(prior.failure) as DurableTurnFailure
    const baseline = await modelUsage(harness)
    await harness.commit(async (tx) => {
      const run = await tx.doc(DurableRunDoc, opts.requestId, policy)
      run.apiPricing ??= auth?.type === "api_key"
      run.usageBaseline ||= JSON.stringify(baseline)
      if (failure) run.failure = JSON.stringify(failure)
      if (!run.evidence && opts.runContext)
        run.evidence = JSON.stringify(opts.runContext.durableSnapshot)
      if (!run.hostState && opts.hostState)
        run.hostState = JSON.stringify(opts.hostState.capture())
    }, context)
    if (opts.sessionFileRef) opts.sessionFileRef.current = opts.storageFile
    const stop = () => {
      stopping = true
      stopPromise ??= (async () => {
        if (active > 0)
          await new Promise<void>((resolve) => {
            releaseActive = resolve
          })
        await conversation.abort(context)
      })().then(undefined, (cause: unknown) => {
        stopError = cause
      })
    }
    opts.signal?.addEventListener("abort", stop, { once: true })
    // AbortSignal does not replay an event that arrived during async startup.
    if (opts.signal?.aborted) stop()
    try {
      if (failure || stopping) {
        stop()
        await stopPromise
      }
      if (!existing && !failure && !stopping) {
        const parsed = parseModelSpec(opts.modelSpec)
        resolveModel(opts.modelRuntime, opts.modelSpec)
        await conversation.configure(
          {
            model: { provider: parsed.provider, modelId: parsed.modelId },
            thinkingLevel: parsed.thinkingLevel,
            instructions: opts.systemPrompt,
            extensions: [extension],
            tools,
          },
          context,
        )
      }
      const submission = existing
        ? await harness.submission(existing.id, context)
        : !failure && !stopping
          ? await conversation.submit(
              {
                type: "input",
                content: opts.prompt,
                requestId: opts.requestId,
              },
              context,
            )
          : undefined
      const receipt = submission ? await submission.wait(context) : undefined
      if (stopPromise) await stopPromise
      const record = await runSnapshot()
      if (failure)
        await harness.commit(async (tx) => {
          const run = await tx.doc(DurableRunDoc, opts.requestId, policy)
          run.failure = JSON.stringify(failure)
        }, context)
      const answer =
        receipt?.type === "input" && receipt.status === "done"
          ? (await storage.entry(receipt.answer, context))?.entry
          : undefined
      const message =
        answer && AssistantEntry.is(answer) ? answer.model?.[0] : undefined
      const savedUsage = record?.usage
        ? (JSON.parse(record.usage) as RunUsage)
        : undefined
      const usage = savedUsage
        ? { ...savedUsage, costUsd: savedUsage.costUsd ?? undefined }
        : requestUsage(
            await modelUsage(harness),
            JSON.parse(
              record?.usageBaseline ?? JSON.stringify(baseline),
            ) as RunUsage,
            record?.apiPricing === true,
          )
      if (!savedUsage)
        await harness.commit(async (tx) => {
          const run = await tx.doc(DurableRunDoc, opts.requestId, policy)
          run.usage = JSON.stringify({
            ...usage,
            costUsd: usage.costUsd ?? null,
          })
        }, context)
      if (stopPromise) await stopPromise
      if (stopError !== undefined) throw stopError
      const completed = !stopping && !failure && message?.role === "assistant"
      const calls = completed
        ? message.content.filter((block) => block.type === "toolCall")
        : []
      return {
        text: completed
          ? message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("")
          : "",
        // Only the exact answer entry decides, and only as its sole call.
        finish:
          finishTool && calls.length === 1 && calls[0]!.name === finishTool.name
            ? validateToolArguments(finishTool, calls[0]!)
            : undefined,
        usage,
        sessionFile: opts.storageFile,
        ...(failure
          ? { failure }
          : receipt?.status === "unanswered" && !stopping
            ? {
                failure: {
                  kind: "unanswered" as const,
                  message: receipt.reason,
                  toolNames: [],
                },
              }
            : {}),
      }
    } finally {
      opts.signal?.removeEventListener("abort", stop)
      if (stopPromise) await stopPromise
    }
  } finally {
    if (harness) await harness.close(context)
    else await storage.close(context)
  }
}

function errorResult(text: string): ToolExecutionResult {
  return { content: [{ type: "text", text }], isError: true }
}

async function modelUsage(harness: Harness): Promise<RunUsage> {
  const usage: RunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    newTokens: 0,
    billedTokens: 0,
    costUsd: 0,
  }
  // Native totals include compaction and failed attempts without transcript entries.
  for (const turn of Object.values((await harness.usage(context)).models)) {
    usage.inputTokens += turn.input + turn.cacheWrite
    usage.outputTokens += turn.output
    usage.newTokens += turn.input + turn.cacheWrite + turn.output
    usage.billedTokens += turn.totalTokens
    usage.costUsd! += turn.cost.total
  }
  return usage
}

function requestUsage(
  total: RunUsage,
  baseline: RunUsage,
  apiPricing: boolean,
): RunUsage {
  return {
    inputTokens: total.inputTokens - baseline.inputTokens,
    outputTokens: total.outputTokens - baseline.outputTokens,
    newTokens: total.newTokens - baseline.newTokens,
    billedTokens: total.billedTokens - baseline.billedTokens,
    costUsd: apiPricing ? total.costUsd! - baseline.costUsd! : undefined,
  }
}
