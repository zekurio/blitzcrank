import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"

import type {
  AuthInteraction,
  LoginOptions,
  OAuthCredential,
} from "@earendil-works/pi-ai"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Deferred, Effect } from "effect"

import { openAuthTerminal } from "./auth-terminal.ts"
import {
  authStatusEffect,
  installationIdEffect,
  loginEffect,
  modelRuntimeOptions,
  resolveAuthPath,
} from "./auth.ts"
import { parseCommand } from "./cli-command.ts"

const interaction: AuthInteraction = {
  prompt: () => Promise.reject(new Error("Unexpected prompt")),
  notify: () => {},
}

test("CLI routing never starts the server for auth, help, or invalid arguments", () => {
  assert.deepEqual(parseCommand([]), { kind: "server" })
  for (const args of [["--help"], ["auth"], ["auth", "--help"]]) {
    assert.deepEqual(parseCommand(args), { kind: "help" })
  }
  assert.deepEqual(parseCommand(["auth", "login", "openai"]), {
    kind: "auth",
    command: { action: "login", provider: "openai" },
  })
  assert.deepEqual(parseCommand(["auth", "logout", "openai"]), {
    kind: "auth",
    command: { action: "logout", provider: "openai" },
  })
  assert.deepEqual(parseCommand(["auth", "status"]), {
    kind: "auth",
    command: { action: "status" },
  })
  for (const args of [
    ["unknown"],
    ["auth", "login"],
    ["auth", "logout"],
    ["auth", "login", "--bad"],
    ["auth", "login", "openai", "extra"],
    ["auth", "status", "extra"],
  ]) {
    assert.throws(() => parseCommand(args), /Invalid command/)
  }
})

test("runtime paths belong to Blitzcrank, with explicit overrides", () => {
  assert.equal(resolveAuthPath(), resolve("data/auth.json"))
  assert.equal(resolveAuthPath(undefined, "state"), resolve("state/auth.json"))
  assert.equal(
    resolveAuthPath("other/auth.json", "state"),
    resolve("other/auth.json"),
  )
  const defaults = modelRuntimeOptions({})
  assert.equal(defaults.modelsPath, null)
  assert.equal(defaults.authPath, resolve("data/auth.json"))
  const custom = modelRuntimeOptions({ modelsPath: "custom/models.json" })
  assert.equal(custom.modelsPath, resolve("custom/models.json"))
  assert.ok(custom.modelsStore)
})

test("installation identity is stable, private, and safe under concurrent creation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blitzcrank-auth-id-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const authPath = join(dir, "nested", "auth.json")
  const ids = await Promise.all(
    Array.from({ length: 12 }, () =>
      Effect.runPromise(installationIdEffect(authPath)),
    ),
  )
  assert.equal(new Set(ids).size, 1)
  assert.equal(await Effect.runPromise(installationIdEffect(authPath)), ids[0])
  assert.match(ids[0]!, /^[0-9a-f-]{36}$/)
  assert.equal((await stat(`${authPath}.device-id`)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(join(dir, "nested")), ["auth.json.device-id"])
  await writeFile(`${authPath}.device-id`, "broken-existing-identity")
  await assert.rejects(
    Effect.runPromise(installationIdEffect(authPath)),
    /do not reset/,
  )
  assert.equal(
    await readFile(`${authPath}.device-id`, "utf8"),
    "broken-existing-identity",
  )
})

test("SDK login persists credentials with a stable ID; runtime refresh and logout share the store", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blitzcrank-auth-flow-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const authPath = join(dir, "auth.json")
  const options = {
    ...modelRuntimeOptions({ authPath }),
    refreshOnCreate: false,
  }
  const runtime = await ModelRuntime.create(options)
  const provider = openaiProvider()
  const oauth = provider.auth.oauth!
  const ids: string[] = []
  const credential = {
    type: "oauth" as const,
    access: "test-only-access",
    refresh: "test-only-refresh",
    expires: Date.now() + 60 * 60 * 1000,
  }
  t.mock.method(
    oauth,
    "login",
    async (_interaction: AuthInteraction, options?: LoginOptions) => {
      ids.push(options!.getDeviceId!())
      return credential
    },
  )
  t.mock.method(oauth, "toAuth", async (value: OAuthCredential) => ({
    apiKey: value.access,
  }))
  const refresh = t.mock.method(oauth, "refresh", async () => ({
    ...credential,
    access: "test-only-refreshed-access",
    expires: Date.now() + 3 * 60 * 60 * 1000,
  }))
  runtime.registerNativeProvider(provider)
  await Effect.runPromise(loginEffect(runtime, "openai", authPath, interaction))
  await Effect.runPromise(loginEffect(runtime, "openai", authPath, interaction))
  assert.equal(ids[0], ids[1])
  assert.equal(ids[0], (await readFile(`${authPath}.device-id`, "utf8")).trim())
  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
    openai: credential,
  })
  assert.equal((await stat(authPath)).mode & 0o777, 0o600)

  const restored = await ModelRuntime.create(options)
  restored.registerNativeProvider(provider)
  const status = await Effect.runPromise(authStatusEffect(restored))
  assert.ok(status.includes("openai: oauth"))
  assert.ok(!status.join("\n").includes("test-only"))
  assert.equal(refresh.mock.callCount(), 0)
  await restored.getAuth("openai", { minOAuthValidityMs: 2 * 60 * 60 * 1000 })
  assert.equal(refresh.mock.callCount(), 1)
  assert.match(await readFile(authPath, "utf8"), /test-only-refreshed-access/)
  await restored.logout("openai")
  assert.deepEqual(await restored.listCredentials(), [])
  assert.equal(await Effect.runPromise(installationIdEffect(authPath)), ids[0])
})

test("failed and cancelled logins preserve credentials and do not expose provider error secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blitzcrank-auth-failure-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const authPath = join(dir, "auth.json")
  const original = JSON.stringify({
    openai: { type: "api_key", key: "test-only-existing" },
  })
  await writeFile(authPath, original)
  const runtime = await ModelRuntime.create({
    ...modelRuntimeOptions({ authPath }),
    refreshOnCreate: false,
  })
  const provider = openaiProvider()
  t.mock.method(provider.auth.oauth!, "login", () =>
    Promise.reject(new Error("test-only-sensitive-provider-response")),
  )
  runtime.registerNativeProvider(provider)
  await assert.rejects(
    Effect.runPromise(loginEffect(runtime, "openai", authPath, interaction)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Login to openai failed/)
      assert.doesNotMatch(String(error), /sensitive-provider-response/)
      return true
    },
  )
  await assert.rejects(
    Effect.runPromise(
      loginEffect(runtime, "openai", authPath, {
        ...interaction,
        signal: AbortSignal.abort(),
      }),
    ),
    /Login cancelled/,
  )
  assert.equal(await readFile(authPath, "utf8"), original)
})

test("cancelling a pending SDK login prevents a late provider result from being saved", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blitzcrank-auth-abort-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const authPath = join(dir, "auth.json")
  const runtime = await ModelRuntime.create({
    ...modelRuntimeOptions({ authPath }),
    refreshOnCreate: false,
  })
  const provider = openaiProvider()
  const started = Deferred.makeUnsafe<void>()
  const completed = Deferred.makeUnsafe<OAuthCredential>()
  t.mock.method(provider.auth.oauth!, "login", () => {
    Effect.runSync(Deferred.succeed(started, undefined))
    return Effect.runPromise(Deferred.await(completed))
  })
  runtime.registerNativeProvider(provider)
  const controller = new AbortController()
  const pending = Effect.runPromise(
    loginEffect(runtime, "openai", authPath, {
      ...interaction,
      signal: controller.signal,
    }),
  )
  await Effect.runPromise(Deferred.await(started))
  controller.abort()
  await assert.rejects(pending, /Login cancelled/)
  Effect.runSync(
    Deferred.succeed(completed, {
      type: "oauth" as const,
      access: "test-only-late-access",
      refresh: "test-only-late-refresh",
      expires: Date.now() + 3600_000,
    }),
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(
    await runtime.listCredentials({ signal: new AbortController().signal }),
    [],
  )
  assert.doesNotMatch(await readFile(authPath, "utf8"), /test-only-late/)
})

test("post-login synchronization failure reports saved credentials without exposing them", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blitzcrank-auth-sync-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const authPath = join(dir, "auth.json")
  const runtime = await ModelRuntime.create({
    ...modelRuntimeOptions({ authPath }),
    refreshOnCreate: false,
  })
  const provider = openaiProvider()
  const credential: OAuthCredential = {
    type: "oauth",
    access: "test-only-saved-access",
    refresh: "test-only-saved-refresh",
    expires: Date.now() + 3600_000,
  }
  t.mock.method(provider.auth.oauth!, "login", async () => {
    provider.refreshModels = () =>
      Promise.reject(new Error("test-only-sensitive-sync-error"))
    return credential
  })
  runtime.registerNativeProvider(provider)
  await assert.rejects(
    Effect.runPromise(loginEffect(runtime, "openai", authPath, interaction)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Credentials were saved/)
      assert.doesNotMatch(String(error), /test-only/)
      return true
    },
  )
  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
    openai: credential,
  })
})

test("terminal masks secrets, translates selections, and cancels prompts without cancelling login", async (t) => {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()))
  const before = process.listenerCount("SIGTERM")
  const terminal = openAuthTerminal(input, output)
  t.after(() => terminal.close())
  const prompt = terminal.interaction.prompt({
    type: "manual_code",
    message: "Paste redirect URL",
  })
  input.write("https://callback.test/?code=test-only-secret\r")
  assert.equal(await prompt, "https://callback.test/?code=test-only-secret")
  assert.doesNotMatch(chunks.join(""), /test-only-secret/)
  const recall = terminal.interaction.prompt({
    type: "text",
    message: "Visible input",
  })
  input.write("\x1b[A\r")
  assert.equal(await recall, "")
  assert.doesNotMatch(chunks.join(""), /test-only-secret/)
  const selection = terminal.interaction.prompt({
    type: "select",
    message: "Choose a method",
    options: [
      { id: "browser", label: "Browser" },
      { id: "device", label: "Device" },
    ],
  })
  input.write("2\r")
  assert.equal(await selection, "device")

  const controller = new AbortController()
  const cancelled = terminal.interaction.prompt({
    type: "manual_code",
    message: "Browser can finish this step",
    signal: controller.signal,
  })
  input.write("test-only-partial-secret")
  controller.abort()
  await assert.rejects(cancelled, /abort/i)
  assert.equal(terminal.interaction.signal!.aborted, false)
  const next = terminal.interaction.prompt({
    type: "text",
    message: "After callback",
  })
  input.write("\x1b[A\r")
  assert.equal(await next, "")
  assert.doesNotMatch(chunks.join(""), /test-only-partial-secret/)
  const pending = terminal.interaction.prompt({
    type: "text",
    message: "Next step",
  })
  input.write("\x03")
  await assert.rejects(pending, /abort/i)
  assert.equal(terminal.interaction.signal!.aborted, true)
  terminal.close()
  assert.equal(process.listenerCount("SIGTERM"), before)
})

test("EOF cancels a terminal prompt", async (t) => {
  const input = new PassThrough()
  const terminal = openAuthTerminal(input, new PassThrough())
  t.after(() => terminal.close())
  const pending = terminal.interaction.prompt({
    type: "text",
    message: "Input",
  })
  input.end()
  await assert.rejects(pending, /abort/i)
})

test("CLI help, status, logout, and errors are independent of service config and ambient Pi state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blitzcrank-cli-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pi = join(dir, "pi")
  await mkdir(pi)
  await writeFile(join(pi, "models.json"), "invalid ambient config")
  await writeFile(join(pi, "auth.json"), "invalid ambient credentials")
  const dataDir = join(dir, "state")
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    BLITZCRANK_DATA_DIR: dataDir,
    PI_CODING_AGENT_DIR: pi,
  }
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        // A partial server startup may already have live resource handles.
        ...(args.length === 0
          ? ["--import", "data:text/javascript,setInterval(() => {}, 60000)"]
          : []),
        "src/cli.ts",
        ...args,
      ],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: environment,
      },
    )
  const help = run("--help")
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /blitzcrank auth login/)
  const empty = run("auth", "status")
  assert.equal(empty.status, 0, empty.stderr)
  assert.match(empty.stdout, /No stored credentials/)
  await mkdir(dataDir, { recursive: true })
  const authPath = join(dataDir, "auth.json")
  await writeFile(
    authPath,
    JSON.stringify({
      openai: { type: "api_key", key: "test-only-cli-key" },
    }),
  )
  const status = run("auth", "status")
  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /openai: api_key/)
  assert.doesNotMatch(status.stdout + status.stderr, /test-only-cli-key/)
  const logout = run("auth", "logout", "openai")
  assert.equal(logout.status, 0, logout.stderr)
  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {})
  const login = run("auth", "login", "openai")
  assert.equal(login.status, 1, login.stderr)
  assert.match(login.stderr, /interactive terminal/)
  const invalid = run("auth", "login")
  assert.equal(invalid.status, 1, invalid.stderr)
  assert.match(invalid.stderr, /Invalid command/)
  const server = run()
  assert.equal(server.status, 1, server.stderr)
  assert.match(server.stderr, /SEERR_URL and SEERR_API_KEY/)
  environment.SEERR_URL = "http://seerr.test"
  environment.SEERR_API_KEY = "test-only-key"
  const noModel = run()
  assert.equal(noModel.status, 1, noModel.stderr)
  assert.match(noModel.stderr, /BLITZCRANK_MODEL must name a model/)
  await writeFile(authPath, "test-only-invalid-sensitive-json")
  const corrupt = run("auth", "status")
  assert.equal(corrupt.status, 1, corrupt.stderr)
  assert.match(corrupt.stderr, /Could not read stored credentials/)
  assert.doesNotMatch(corrupt.stdout + corrupt.stderr, /test-only-invalid/)
  assert.equal(
    await readFile(authPath, "utf8"),
    "test-only-invalid-sensitive-json",
  )
  await writeFile(authPath, "{}")
  environment.BLITZCRANK_MODELS_PATH = join(pi, "models.json")
  const invalidModels = run("auth", "status")
  assert.equal(invalidModels.status, 1, invalidModels.stderr)
  assert.match(invalidModels.stderr, /Invalid model configuration/)
  assert.deepEqual((await readdir(pi)).sort(), ["auth.json", "models.json"])
})
