import { Type, type Static } from "typebox"

const text = Type.String({
  minLength: 1,
  pattern: "\\S",
  not: { pattern: "\0" },
})
const snowflake = Type.String({ pattern: "^[0-9]{1,32}$" })
const secret = Type.Union([
  text,
  Type.Object(
    { env: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }) },
    { additionalProperties: false },
  ),
  Type.Object({ file: text }, { additionalProperties: false }),
])
const service = Type.Object(
  { url: text, apiKey: secret },
  { additionalProperties: false },
)
const discord = Type.Object(
  {
    id: Type.String({
      pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
      maxLength: 64,
    }),
    type: Type.Literal("discord"),
    token: secret,
    guildId: snowflake,
    reportChannelId: snowflake,
    inboxChannelIds: Type.Optional(
      Type.Array(snowflake, { uniqueItems: true }),
    ),
    model: Type.Optional(text),
    triageModel: Type.Optional(text),
    adminRoleIds: Type.Optional(Type.Array(snowflake, { uniqueItems: true })),
  },
  { additionalProperties: false },
)

/** The file and legacy environment adapter go through the same validation. */
export const ConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
    dataDir: Type.Optional(text),
    automationsDir: Type.Optional(text),
    webhookSecret: Type.Optional(secret),
    model: Type.Optional(text),
    automationModel: Type.Optional(text),
    automationModels: Type.Optional(Type.Record(Type.String(), text)),
    authPath: Type.Optional(text),
    modelsPath: Type.Optional(text),
    language: Type.Optional(text),
    seerrBotUserId: Type.Optional(snowflake),
    seerrBotUsername: Type.Optional(text),
    seerr: service,
    sonarr: Type.Optional(service),
    radarr: Type.Optional(service),
    sabnzbd: Type.Optional(service),
    jellyfin: Type.Optional(service),
    anvil: Type.Optional(
      Type.Object(
        { command: Type.Optional(text), socket: text },
        { additionalProperties: false },
      ),
    ),
    media: Type.Optional(
      Type.Object(
        { roots: Type.Array(text, { uniqueItems: true }) },
        { additionalProperties: false },
      ),
    ),
    web: Type.Optional(
      Type.Union([
        Type.Object(
          { provider: Type.Literal("none") },
          { additionalProperties: false },
        ),
        Type.Object(
          { provider: Type.Literal("firecrawl"), apiKey: secret },
          { additionalProperties: false },
        ),
      ]),
    ),
    gateways: Type.Optional(Type.Array(discord)),
  },
  { additionalProperties: false },
)

export type FileConfig = Static<typeof ConfigSchema>
export type Secret = Static<typeof secret>
