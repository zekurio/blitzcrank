import express from "express";
import {
  WebhookClient,
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
} from "discord.js";

const app = express();
app.use(express.json());

const PORT = 3000; // Choose an appropriate port

// Replace with your Discord webhook URL
const webhookClient = new WebhookClient({
  url: "https://discord.com/api/webhooks/your_webhook_id/your_webhook_token",
});

app.post("/webhook", async (req, res) => {
  const payload = req.body;

  // Create an embed based on the webhook payload
  const embed = new EmbedBuilder()
    .setTitle(payload.subject)
    .setDescription(payload.message)
    .setImage(payload.image);

  // Add fields based on the payload content
  if (payload.media) {
    embed.addFields(
      { name: "Media Type", value: payload.media.media_type },
      { name: "Status", value: payload.media.status }
    );
    embed.setThumbnail(payload.media.poster_path);
  }

  if (payload.request) {
    embed.addFields({
      name: "Requested By",
      value: payload.request.requestedBy_username,
    });
  }

  // Create buttons
  const approveButton = new ButtonBuilder()
    .setCustomId("approve")
    .setLabel("Approve")
    .setStyle(ButtonStyle.Success);

  const denyButton = new ButtonBuilder()
    .setCustomId("deny")
    .setLabel("Deny")
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    approveButton,
    denyButton
  );

  try {
    await webhookClient.send({
      embeds: [embed],
      components: [row],
    });
    res.status(200).send("Webhook processed successfully");
  } catch (error) {
    console.error("Error sending Discord message:", error);
    res.status(500).send("Error processing webhook");
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
