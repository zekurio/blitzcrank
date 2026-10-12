import { randomUUID } from "node:crypto"
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import {
  InMemoryModelsStore,
  type AuthInteraction,
} from "@earendil-works/pi-ai"
import {
  CredentialSynchronizationError,
  ModelRuntime,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent"
import { Data, Effect } from "effect"

import { openAuthTerminal } from "./auth-terminal.ts"
import type { AuthCommand } from "./cli-command.ts"

export class AuthError extends Data.TaggedError("AuthError")<{
  message: string
}> {}

interface RuntimePaths {
  dataDir?: string | undefined
  authPath?: string | undefined
  modelsPath?: string | undefined
}

export function resolveAuthPath(authPath?: string, dataDir?: string): string {
  return resolve(authPath ?? join(dataDir ?? "data", "auth.json"))
}

/** Both server and auth use app-owned credentials, never ambient Pi files. */
export function modelRuntimeOptions(paths: RuntimePaths) {
  return {
    authPath: resolveAuthPath(paths.authPath, paths.dataDir),
    modelsPath: paths.modelsPath ? resolve(paths.modelsPath) : null,
    // A custom models.json may be read-only, including in the Nix store.
    modelsStore: new InMemoryModelsStore(),
  } satisfies CreateModelRuntimeOptions
}

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

/** Publish a complete UUID without ever replacing another login's identity. */
export function installationIdEffect(
  authPath: string,
): Effect.Effect<string, AuthError> {
  const file = `${authPath}.device-id`
  return Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!isFileError(error, "ENOENT")) return Effect.fail(error)
      const id = randomUUID()
      const temporary = `${file}.${randomUUID()}.tmp`
      return Effect.acquireUseRelease(
        Effect.tryPromise(async () => {
          await mkdir(dirname(file), { recursive: true, mode: 0o700 })
          await writeFile(temporary, `${id}\n`, {
            flag: "wx",
            mode: 0o600,
            flush: true,
          })
          return temporary
        }),
        (temporary) =>
          Effect.tryPromise(async () => {
            await link(temporary, file).catch((error: unknown) => {
              if (!isFileError(error, "EEXIST")) throw error
            })
            return readFile(file, "utf8")
          }),
        (temporary) => Effect.promise(() => unlink(temporary)),
      )
    }),
    Effect.flatMap((value) => {
      const id = value.trim()
      return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
        ? Effect.succeed(id)
        : Effect.fail(new Error("Invalid installation UUID"))
    }),
    Effect.mapError(
      () =>
        new AuthError({
          message: `Could not read or create a valid installation UUID at ${file}. Check its contents and permissions; do not reset an existing identity.`,
        }),
    ),
  )
}

export function loginEffect(
  runtime: ModelRuntime,
  providerId: string,
  authPath: string,
  interaction: AuthInteraction,
): Effect.Effect<void, AuthError> {
  return Effect.gen(function* () {
    const provider = runtime.getProvider(providerId)
    if (!provider?.auth.oauth) {
      return yield* new AuthError({
        message: `Provider ${providerId} does not support OAuth login. Check the provider ID; API keys use environment variables.`,
      })
    }
    if (interaction.signal?.aborted) {
      return yield* new AuthError({ message: "Login cancelled." })
    }
    const id = yield* installationIdEffect(authPath)
    yield* Effect.tryPromise({
      try: () =>
        runtime.login(providerId, "oauth", interaction, {
          getDeviceId: () => id,
        }),
      // Provider errors can include token responses; never print them verbatim.
      catch: (error) =>
        new AuthError({
          message:
            error instanceof CredentialSynchronizationError
              ? "Credentials were saved, but model availability could not be refreshed. Run blitzcrank auth status."
              : interaction.signal?.aborted
                ? "Login cancelled."
                : `Login to ${providerId} failed. Check the browser flow, network, callback port, and auth-file permissions, then retry.`,
        }),
    })
  })
}

/** Metadata only: no token refresh, API-key commands, or network requests. */
export function authStatusEffect(runtime: ModelRuntime) {
  return Effect.tryPromise({
    // Without a signal the SDK may return stale metadata after a read failure.
    try: (signal) => runtime.listCredentials({ signal }),
    catch: () =>
      new AuthError({
        message: "Could not read stored credentials. Check the auth file.",
      }),
  }).pipe(
    Effect.map((credentials) =>
      credentials.length === 0
        ? [
            "No stored credentials. API keys may be supplied via the environment.",
          ]
        : [
            ...credentials
              .map(
                (credential) => `${credential.providerId}: ${credential.type}`,
              )
              .sort(),
            "Stored credentials only; validity is not checked. Environment API keys are not listed.",
          ],
    ),
  )
}

export function runAuthEffect(
  command: AuthCommand,
): Effect.Effect<void, AuthError> {
  return Effect.gen(function* () {
    if (
      command.action === "login" &&
      (!process.stdin.isTTY || !process.stdout.isTTY)
    ) {
      return yield* new AuthError({
        message: "OAuth login requires an interactive terminal.",
      })
    }
    const options = modelRuntimeOptions({
      dataDir: process.env.BLITZCRANK_DATA_DIR,
      authPath: process.env.BLITZCRANK_AUTH_PATH,
      modelsPath: process.env.BLITZCRANK_MODELS_PATH,
    })
    const runtime = yield* Effect.tryPromise({
      try: () => ModelRuntime.create({ ...options, refreshOnCreate: false }),
      catch: () =>
        new AuthError({
          message:
            "Could not load auth or model configuration. Check paths, permissions, and JSON syntax.",
        }),
    })
    if (runtime.getError()) {
      return yield* new AuthError({
        message: "Invalid model configuration. Check BLITZCRANK_MODELS_PATH.",
      })
    }
    if (command.action === "status") {
      for (const line of yield* authStatusEffect(runtime)) console.log(line)
      return
    }
    if (command.action === "logout") {
      yield* Effect.tryPromise({
        try: () => runtime.logout(command.provider),
        catch: (error) =>
          new AuthError({
            message:
              error instanceof CredentialSynchronizationError
                ? "Stored credentials were removed, but model availability could not be refreshed."
                : "Could not remove stored credentials. Check auth-file permissions.",
          }),
      })
      console.log(
        `Removed stored credentials for ${command.provider}. Environment API keys are unchanged.`,
      )
      return
    }
    yield* Effect.acquireUseRelease(
      Effect.sync(() => openAuthTerminal()),
      (terminal) =>
        loginEffect(
          runtime,
          command.provider,
          options.authPath,
          terminal.interaction,
        ),
      (terminal) => Effect.sync(() => terminal.close()),
    )
    console.log(
      `Logged in to ${command.provider}. Credentials saved to ${options.authPath}.`,
    )
  })
}
