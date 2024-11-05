import { Pool } from "pg";
import fs from "fs";
import path from "path";
import type { DatabaseInterface } from "../interface";
import type { ServerEmote } from "../models";
import logger from "../../logger";

export class PostgresDatabase implements DatabaseInterface {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
    });
  }

  async connect(): Promise<void> {
    try {
      await this.pool.connect();
      logger.info("Connected to PostgreSQL database");
    } catch (error) {
      logger.error("Error connecting to PostgreSQL database", error);
      throw error;
    }
  }

  async init(): Promise<void> {
    try {
      await this.connect();
      await this.createMigrationsTable();
      await this.runMigrations();
    } catch (error) {
      logger.error("Error initializing database", error);
      throw error;
    }
  }

  private async createMigrationsTable(): Promise<void> {
    const sql = `
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await this.pool.query(sql);
  }

  private async runMigrations(): Promise<void> {
    const migrationsDir = path.join(__dirname, "migrations");
    const migrationFiles = fs.readdirSync(migrationsDir).sort();

    for (const file of migrationFiles) {
      if (path.extname(file) === ".sql") {
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, "utf-8");

        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          const result = await client.query(
            "SELECT * FROM migrations WHERE name = $1",
            [file]
          );
          if (result.rows.length === 0) {
            await client.query(sql);
            await client.query("INSERT INTO migrations (name) VALUES ($1)", [
              file,
            ]);
            await client.query("COMMIT");
            logger.info(`Executed migration: ${file}`);
          } else {
            logger.info(`Skipping migration: ${file} (already executed)`);
          }
        } catch (error) {
          await client.query("ROLLBACK");
          logger.error(`Error executing migration ${file}`, error);
          throw error;
        } finally {
          client.release();
        }
      }
    }
  }

  async getServerEmotes(guildId: string): Promise<ServerEmote[]> {
    // define empty array
    const emotes: ServerEmote[] = [];

    const query = `SELECT * FROM server_emotes WHERE guild_id = $1`;

    const result = await this.pool.query(query, [guildId]);

    for (const row of result.rows) {
      const emote: ServerEmote = {
        guildId: row.guild_id,
        sevenTvEmote: row.seven_tv_emote,
        discordEmoji: row.discord_emoji,
      };
    }

    return emotes;
  }
}
