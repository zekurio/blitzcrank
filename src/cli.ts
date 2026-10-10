import { Cause, Effect } from "effect"

import { CLI_HELP, parseCommand } from "./cli-command.ts"

const args = process.argv.slice(2)
const command = Effect.try({
  try: () => parseCommand(args),
  catch: (error) => error,
}).pipe(
  Effect.flatMap((command) => {
    if (command.kind === "help") {
      return Effect.sync(() => console.log(CLI_HELP))
    }
    if (command.kind === "server") {
      return Effect.promise(() => import("./index.ts")).pipe(
        Effect.flatMap((server) => server.startServerEffect()),
      )
    }
    return Effect.promise(() => import("./auth.ts")).pipe(
      Effect.flatMap((auth) => auth.runAuthEffect(command.command)),
    )
  }),
)

Effect.runFork(
  command.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        const error = Cause.squash(cause)
        // Partial service startup can already own cron/queue handles.
        if (args.length === 0) {
          console.error("fatal:", error)
          process.exit(1)
        }
        console.error(
          error instanceof Error ? error.message : "Command failed.",
        )
        process.exitCode = 1
      }),
    ),
  ),
)
