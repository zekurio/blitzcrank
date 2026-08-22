import {
  InteractionContextType,
  SlashCommandBuilder,
  type Client,
} from "discord.js"

/** Discord allows at most 25 static choices per option. */
const MAX_CHOICES = 25

export const AUTOMATION_COMMAND = "automation"

function automationCommand(names: string[]): SlashCommandBuilder {
  const command = new SlashCommandBuilder()
    .setName(AUTOMATION_COMMAND)
    .setDescription("Inspect and trigger blitzcrank automations")
    // UI hygiene only — admins can always see the command, and the handler
    // authorizes every invocation itself.
    .setDefaultMemberPermissions(0n)
    .setContexts(InteractionContextType.Guild)
  command.addSubcommand((sub) =>
    sub
      .setName("list")
      .setDescription("Show automations, their schedule and next run"),
  )
  command.addSubcommand((sub) =>
    sub
      .setName("run")
      .setDescription("Queue an automation run now")
      .addStringOption((opt) => {
        opt
          .setName("name")
          .setDescription("Automation to run")
          .setRequired(true)
        // Discord's option choices must be non-empty when present: an
        // empty `choices: []` is a different (and broken) thing from no
        // choices at all. With nothing checked in yet, fall back to a
        // free-text option instead of attaching zero choices.
        if (names.length === 0) return opt
        return opt.addChoices(
          ...names.slice(0, MAX_CHOICES).map((name) => ({ name, value: name })),
        )
      }),
  )
  return command
}

/** Bulk overwrite: the guild set becomes exactly what we declare. */
export async function syncCommands(
  client: Client<true>,
  guildId: string,
  names: string[],
): Promise<void> {
  await client.application.commands.set([automationCommand(names)], guildId)
}
