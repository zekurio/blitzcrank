import { Pool } from "pg";
import fs from "fs";
import path from "path";
import type { DatabaseInterface } from "../interface";
import type { StarboardConfig, StarboardEntry } from "../models";
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
  async setStarboardConfig(config: StarboardConfig): Promise<void> {
    const sql = `
      INSERT INTO starboard_configs (guild_id, channel_id, threshold, emoji)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (guild_id, channel_id) DO UPDATE SET
        threshold = EXCLUDED.threshold,
        emoji = EXCLUDED.emoji;
    `;
    await this.pool.query(sql, [
      config.guildId,
      config.channelId,
      config.threshold,
      config.emoji,
    ]);
  }

  async getStarboardConfig(
    guildId: string,
    channelId: string
  ): Promise<StarboardConfig | null> {
    return null;
  }

  async setStarboardEntry(entry: StarboardEntry): Promise<void> {
    const sql = `
      INSERT INTO starboard_entries (message_id, starboard_id, guild_id, channel_id, author_id, score)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (message_id) DO UPDATE SET
        starboard_id = EXCLUDED.starboard_id,
        guild_id = EXCLUDED.guild_id,
        channel_id = EXCLUDED.channel_id,
        author_id = EXCLUDED.author_id,
        score = EXCLUDED.score;
    `;
    await this.pool.query(sql, [
      entry.messageId,
      entry.starboardId,
      entry.guildId,
      entry.channelId,
      entry.authorId,
      entry.score,
    ]);
  }

  async getStarboardEntry(messageId: string): Promise<StarboardEntry | null> {
    const sql = `
      SELECT * FROM starboard_entries WHERE message_id = $1;
    `;
    const result = await this.pool.query(sql, [messageId]);
    return result.rows[0] as StarboardEntry | null;
  }

  async removeStarboardEntry(messageId: string): Promise<void> {
    const sql = `
      DELETE FROM starboard_entries WHERE message_id = $1;
    `;
    await this.pool.query(sql, [messageId]);
  }

  async getStarboardEntries(
    guildId: string,
    channelId: string
  ): Promise<StarboardEntry[]> {
    const sql = `
      SELECT * FROM starboard_entries WHERE guild_id = $1 AND channel_id = $2;
    `;
    const result = await this.pool.query(sql, [guildId, channelId]);
    return result.rows as StarboardEntry[];
  }
}
