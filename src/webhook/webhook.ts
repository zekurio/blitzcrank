import { createServer, IncomingMessage, ServerResponse } from "http";
import { config, type Config } from "../config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TextChannel,
  Client,
} from "discord.js";
import { Colors } from "../static";
import logger from "../logger";

class WebhookHandler {
  private server: ReturnType<typeof createServer>;
  private readonly port: number;
  private channelId: string;
  private client: Client;

  constructor(config: Config, client: Client) {
    this.port = config.webserver.port;
    this.server = createServer(this.handleRequest.bind(this));
    this.channelId = config.discord.channelId;
    this.client = client;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "POST" && req.url === "/webhook") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        const payload = JSON.parse(body);

        if (payload.notification_type === "MEDIA_PENDING") {
          await this.sendDiscordMessage(payload);
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Webhook received");
      });
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  }

  public start() {
    this.server.listen(this.port, () => {
      logger.info(`Webhook server listening on port ${this.port}`);
    });
  }

  private createMediaRequestEmbed(notification: any) {
    const embed = new EmbedBuilder()
      .setColor(Colors.JELLYSEERR.PENDING)
      .setTitle(notification.subject.replace(/\s*\(\d{4}\)$/, ""))
      .setDescription(notification.message)
      .setThumbnail(notification.image)
      .setAuthor({
        name: "Pending Request",
      })
      .addFields(
        {
          name: "Type",
          value:
            notification.media.media_type.charAt(0).toUpperCase() +
            notification.media.media_type.slice(1),
          inline: true,
        },
        { name: "Status", value: "Pending", inline: true },
        {
          name: "Requested by",
          value: notification.request.requestedBy_username,
          inline: true,
        },
        {
          name: "Requested at",
          value: new Date().toLocaleString(),
          inline: true,
        }
      )
      .setTimestamp()
      .setFooter({ text: `Request ID: ${notification.request.request_id}` });

    return embed;
  }

  private async sendDiscordMessage(notification: any) {
    try {
      const channel = await this.client.channels.fetch(this.channelId);
      if (channel instanceof TextChannel) {
        const embed = this.createMediaRequestEmbed(notification);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`accept_${notification.request.request_id}`)
            .setLabel("Accept")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`decline_${notification.request.request_id}`)
            .setLabel("Decline")
            .setStyle(ButtonStyle.Danger)
        );

        await channel.send({ embeds: [embed], components: [row] });
      }
    } catch (error) {
      console.error("Error sending Discord message:", error);
    }
  }
}

export default WebhookHandler;
