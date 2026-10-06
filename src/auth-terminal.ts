import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"

import type { AuthInteraction } from "@earendil-works/pi-ai"

/** One terminal owner for the whole login, including waits between prompts. */
export function openAuthTerminal(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
) {
  const controller = new AbortController()
  // Keep codes, redirect URLs, and unsolicited input out of terminal output.
  let hidden = true
  const masked = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!hidden) output.write(chunk)
      callback()
    },
  })
  const readline = createInterface({
    input,
    output: masked,
    terminal: true,
    // Otherwise a later visible prompt can recall a previous hidden answer.
    historySize: 0,
  })
  const abort = () => controller.abort()
  readline.on("SIGINT", abort)
  readline.on("close", abort)
  process.on("SIGINT", abort)
  process.on("SIGTERM", abort)

  const interaction: AuthInteraction = {
    signal: controller.signal,
    async prompt(prompt) {
      const signal = prompt.signal
        ? AbortSignal.any([controller.signal, prompt.signal])
        : controller.signal
      signal.throwIfAborted()
      const secret = prompt.type === "secret" || prompt.type === "manual_code"
      output.write(`${prompt.message}\n`)
      if (prompt.type === "select") {
        for (const [index, option] of prompt.options.entries()) {
          output.write(`  ${index + 1}. ${option.label}\n`)
        }
      }
      for (;;) {
        hidden = secret
        output.write("> ")
        // finally restores masking even when a browser callback cancels input.
        const answer = await readline.question("", { signal }).finally(() => {
          hidden = true
          if (secret) output.write("\n")
        })
        if (prompt.type !== "select") return answer
        const option = prompt.options.find(
          (option, index) =>
            option.id === answer || String(index + 1) === answer,
        )
        if (option) return option.id
        output.write("Choose one of the listed options.\n")
      }
    },
    notify(event) {
      if (event.type === "auth_url") {
        output.write(`${event.url}\n`)
        if (event.instructions) output.write(`${event.instructions}\n`)
        return
      }
      if (event.type === "device_code") {
        output.write(`${event.verificationUri}\nCode: ${event.userCode}\n`)
        return
      }
      output.write(`${event.message}\n`)
      if (event.type === "info") {
        for (const link of event.links ?? []) output.write(`${link.url}\n`)
      }
    },
  }

  return {
    interaction,
    close() {
      readline.close()
      masked.end()
      process.off("SIGINT", abort)
      process.off("SIGTERM", abort)
    },
  }
}
