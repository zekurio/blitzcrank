import {
  Client,
  Events,
  GatewayIntentBits,
  Guild,
  type Interaction,
  ActivityType,
} from "discord.js";
import { config } from "./config";
import { readyEventHandler } from "./events/ready";
import { interactionCreateEventHandler } from "./events/interactioncreate";
import { guildCreateEventHandler } from "./events/guildcreate";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (client: Client) => {
  if (config.logging.level === "debug") {
    client.user?.setActivity("Debugging...", { type: ActivityType.Playing });
    client.user?.setStatus("invisible");
  }
  readyEventHandler(client);
});

client.on(Events.InteractionCreate, (interaction: Interaction) => {
  interactionCreateEventHandler(interaction);
});

client.on(Events.GuildCreate, (guild: Guild) => {
  guildCreateEventHandler(guild);
});

client.login(config.discord.token);
