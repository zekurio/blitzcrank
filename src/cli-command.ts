export type AuthCommand =
  | { action: "login" | "logout"; provider: string }
  | { action: "status" }

export type Command =
  | { kind: "server" }
  | { kind: "help" }
  | { kind: "auth"; command: AuthCommand }

export const CLI_HELP = `Usage:
  blitzcrank                         Start the webhook service
  blitzcrank auth login <provider>   Log in with OAuth
  blitzcrank auth logout <provider>  Remove stored credentials
  blitzcrank auth status             List stored credential types
  blitzcrank --help                  Show this help

For ChatGPT subscription auth, use: blitzcrank auth login openai
API keys use provider environment variables; no login is needed.

Auth uses BLITZCRANK_AUTH_PATH or <BLITZCRANK_DATA_DIR or data>/auth.json.
Auth commands do not require service credentials or BLITZCRANK_MODEL.
`

export function parseCommand(args: string[]): Command {
  if (args.length === 0) return { kind: "server" }
  const help = (arg: string | undefined) =>
    arg === "--help" || arg === "-h" || arg === "help"
  if (
    (args.length === 1 && help(args[0])) ||
    (args[0] === "auth" &&
      (args.length === 1 || (args.length === 2 && help(args[1]))))
  ) {
    return { kind: "help" }
  }
  if (args[0] === "auth") {
    if (args.length === 2 && args[1] === "status") {
      return { kind: "auth", command: { action: "status" } }
    }
    if (
      args.length === 3 &&
      (args[1] === "login" || args[1] === "logout") &&
      /^[a-z0-9][a-z0-9._-]*$/i.test(args[2]!)
    ) {
      return {
        kind: "auth",
        command: { action: args[1], provider: args[2]! },
      }
    }
  }
  throw new Error("Invalid command. Run blitzcrank --help for usage.")
}
