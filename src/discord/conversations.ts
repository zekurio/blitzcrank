import { mkdir, stat } from "node:fs/promises"
import path from "node:path"

import { Effect } from "effect"

import { storageIO } from "../storage.ts"

/** A durable marker keeps conversation identity independent of its title. */
export class DiscordConversations {
  constructor(private readonly dataDir: string) {}

  registerEffect(threadId: string) {
    return Effect.suspend(() =>
      // Recursive mkdir is idempotent when two replies adopt a legacy thread.
      storageIO(() => mkdir(this.marker(threadId), { recursive: true })).pipe(
        Effect.asVoid,
      ),
    )
  }

  hasEffect(threadId: string) {
    return Effect.suspend(() =>
      storageIO(() => stat(this.marker(threadId))).pipe(
        Effect.map((file) => file.isDirectory()),
        Effect.catch((error) =>
          error.code === "ENOENT" ? Effect.succeed(false) : Effect.fail(error),
        ),
      ),
    )
  }

  private marker(threadId: string): string {
    if (!/^\d{1,32}$/.test(threadId)) {
      throw new Error(`invalid Discord thread id "${threadId}"`)
    }
    return path.join(
      this.dataDir,
      "sessions",
      "discord",
      threadId,
      ".conversation",
    )
  }
}
