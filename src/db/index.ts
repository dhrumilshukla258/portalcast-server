import fs from "fs";
import { Sequelize } from "sequelize-typescript";
import path from "path";
import { Token } from "../models/Token";
import { SystemConfig } from "../models/SystemConfig";
import { ConfigProfile } from "../models/ConfigProfile";
import { Channel } from "../models/Channel";
import { Genre } from "../models/Genre";
import { EpgCache } from "../models/EpgCache";
import { XtreamCache } from "../models/XtreamCache";
import { GenreOverride } from "../models/GenreOverride";
import { ContentOverride } from "../models/ContentOverride";
import { StrmMovie } from "../models/StrmMovie";
import { StrmSeries } from "../models/StrmSeries";
import { User } from "../models/User";
import { DeviceCode } from "../models/DeviceCode";
import { UserProgress } from "../models/UserProgress";
import { ContentCache } from "../models/ContentCache";

function resolveDatabasePath(): string {
  const envPath = process.env.SQLITE_DB_PATH;
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, "database.db");
    }
    return resolved;
  }
  // Prefer existing db file for backwards compatibility
  for (const candidate of [
    path.join(process.cwd(), "database.db"),
    path.join(process.cwd(), "database.sqlite"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(process.cwd(), "database.db");
}

export const databasePath = resolveDatabasePath();

const databaseDir = path.dirname(databasePath);
if (!fs.existsSync(databaseDir)) {
  fs.mkdirSync(databaseDir, { recursive: true });
}

export const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: databasePath,
  models: [
    Token, SystemConfig, ConfigProfile, Channel, Genre, EpgCache,
    XtreamCache, GenreOverride, ContentOverride, StrmMovie, StrmSeries,
    User, DeviceCode, UserProgress, ContentCache,
  ],
  logging: false,
});

export async function initDB() {
  try {
    await sequelize.authenticate();
    console.log("Database connection has been established successfully.");
    console.log(`Using SQLite database at: ${databasePath}`);

    // Migrate content_cache: drop old table if it has the wrong PK (auto-increment id instead of cacheKey)
    try {
      const [columns] = await sequelize.query("PRAGMA table_info('content_cache');") as any;
      if (columns && columns.length > 0) {
        const pkColumn = columns.find((c: any) => c.pk === 1);
        if (pkColumn && pkColumn.name !== "cacheKey") {
          console.log("Migration: Recreating content_cache table with cacheKey as primary key...");
          await sequelize.query("DROP TABLE `content_cache`;");
        }
      }
    } catch {
      // Table may not exist yet, sync() will create it
    }

    // Migrate user_progress: drop old table if it lacks profileId column
    try {
      const [columns] = await sequelize.query("PRAGMA table_info('user_progress');") as any;
      if (columns && columns.length > 0) {
        const hasProfileId = columns.some((c: any) => c.name === "profileId");
        if (!hasProfileId) {
          console.log("Migration: Recreating user_progress table to include profileId...");
          await sequelize.query("DROP TABLE `user_progress`;");
        }
      }
    } catch {
      // Table may not exist yet
    }

    await sequelize.sync({ alter: true });
    console.log("Database models synced.");

    // Auto-migrate schema: Add passwordHash and salt columns if they do not exist
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `passwordHash` TEXT;");
      console.log("Migration: Added passwordHash column to users table.");
    } catch {
      // Ignore if the column already exists
    }
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `salt` TEXT;");
      console.log("Migration: Added salt column to users table.");
    } catch {
      // Ignore if the column already exists
    }
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `avatarUrl` TEXT;");
      console.log("Migration: Added avatarUrl column to users table.");
    } catch {
      // Ignore if the column already exists
    }

  } catch (error) {
    console.error("Unable to connect to the database:", error);
  }
}
