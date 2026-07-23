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
import { ContentMeta } from "../models/ContentMeta";
import { ContentGenre } from "../models/ContentGenre";
import { recomputeRepresentatives } from "../content/metaEnrichment";
import { ContentCountry } from "../models/ContentCountry";
import { ContentTheme } from "../models/ContentTheme";
import { logger } from "../infra/logger";

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
    ContentMeta, ContentGenre, ContentCountry, ContentTheme,
  ],
  logging: false,
});

export async function initDB() {
  try {
    await sequelize.authenticate();
    logger.info("Database connection established successfully.");
    logger.info(`Using SQLite database at: ${databasePath}`);

    // PERF INCIDENT (2026-07-17): confirmed via `PRAGMA journal_mode;` that this
    // database was running in SQLite's default "delete" (rollback journal) mode
    // — under that mode, ANY write transaction takes an exclusive lock on the
    // ENTIRE database file for its duration, blocking every other connection's
    // reads until it commits. This app has continuous background writes
    // (BackgroundJobService's Xtream VOD/series cache warming) running
    // alongside user-facing reads (Discover, live TV, etc.) — real timing logs
    // showed Discover queries that complete in ~400ms in isolation instead
    // stalling for 7+ seconds (and possibly much longer) under real concurrent
    // load, with no query-cost explanation left once indexes were fixed.
    // WAL (Write-Ahead Logging) mode is the standard SQLite fix for exactly
    // this "many concurrent readers + occasional writers" shape of workload —
    // readers get a consistent snapshot without waiting on writer locks, and
    // writers don't block readers. This is a property of the database FILE
    // itself (persists across restarts once set), not a per-connection
    // setting, so this only needs to run once — but it's cheap and safe to
    // re-issue on every startup regardless.
    try {
      const [result] = await sequelize.query("PRAGMA journal_mode=WAL;") as any;
      logger.info(`Migration: Set SQLite journal_mode to ${result?.[0]?.journal_mode || "WAL"}.`);
    } catch (e: any) {
      logger.error(`Migration: failed to set WAL journal mode: ${e.message}`);
    }

    // WAL (above) only solves reader-vs-writer blocking — SQLite still allows
    // only one writer at a time, so two writes landing in the same instant
    // (e.g. background content-meta enrichment vs. a user's progress save)
    // would otherwise fail immediately with SQLITE_BUSY instead of just
    // waiting a beat. This makes a colliding writer retry internally for up
    // to 5s before giving up. Same "set once, applies to the single shared
    // connection this dialect keeps for the process lifetime" reasoning as
    // the WAL pragma above — see sequelize's sqlite ConnectionManager, which
    // keys connections by a fixed "default" uuid rather than a real pool.
    try {
      await sequelize.query("PRAGMA busy_timeout=5000;");
      logger.info("Migration: Set SQLite busy_timeout to 5000ms.");
    } catch (e: any) {
      logger.error(`Migration: failed to set busy_timeout: ${e.message}`);
    }

    // `user_progress` is fully hand-managed via raw SQL instead of Sequelize's automatic
    // sync/alter — root-caused this session: the model declares its composite primary key
    // via 3 separate @PrimaryKey decorators, and SQLite has no native ALTER COLUMN, so
    // Sequelize's `alter:true` rebuilds this table via a temp `<table>_backup` copy step.
    // That rebuild's own DDL generation for this 3-decorator composite key is buggy — it
    // derives an extra standalone UNIQUE constraint on `profileId` alone, which then throws
    // outright the moment real data has more than one row sharing a profileId (multiple
    // in-progress items per profile — the normal case). The old fix "let sync() run, then
    // repair the stray index afterward" no longer works: modern Sequelize's rebuild-via-copy
    // fails BEFORE the post-sync repair ever runs, since the copy step itself throws. Since
    // this table is skipped in the per-model sync loop below, any FUTURE column addition to
    // the UserProgress model needs a manual `ALTER TABLE` migration added here too (same
    // pattern as the `users` table columns further down) — sync() will never touch it again.
    try {
      const [columns] = await sequelize.query("PRAGMA table_info('user_progress');") as any;
      const hasProfileId = columns?.some((c: any) => c.name === "profileId");
      if (columns && columns.length > 0 && !hasProfileId) {
        logger.warn("Migration: user_progress lacks profileId column — dropping and recreating. All watch history will be lost.");
        await sequelize.query("DROP TABLE `user_progress`;");
      }
      await sequelize.query(
        "CREATE TABLE IF NOT EXISTS `user_progress` (`userId` INTEGER NOT NULL, `profileId` INTEGER NOT NULL, `mediaId` VARCHAR(255) NOT NULL, `progress` FLOAT, `completed` TINYINT(1), `meta` TEXT, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, PRIMARY KEY (`userId`, `profileId`, `mediaId`));",
      );
    } catch (e: any) {
      logger.error(`Migration: failed to ensure user_progress schema: ${e.message}`);
    }

    // Sync each model individually instead of one `sequelize.sync({alter:true})` call for
    // all of them. That single call aborts entirely on the FIRST model that throws, which
    // silently prevented every model queued after it from ever being created, with no
    // indication why beyond one opaque top-level error. One bad table's schema quirk should
    // never be able to block every other table from syncing.
    //
    // `alter: true` is never used for ANY model, full stop (as of 2026-07-22). It started as
    // a per-model exclusion list (UserProgress, then ContentMeta + its tag tables, then
    // Token/SystemConfig/ConfigProfile/Channel/Genre/GenreOverride/EpgCache...), but every
    // single model added to that list turned out to hit the exact same root bug — Sequelize's
    // SQLite alter-via-rebuild-copy (rename to `<table>_backup`, recreate, copy rows) is
    // fundamentally unreliable on this stack: it throws on tables with FK-referenced rows
    // ("FOREIGN KEY constraint failed"), tables whose rebuild-copy step can't find its own
    // `_backup` table, and tables with more than a trivial PK/unique-index shape
    // ("Validation error") alike. It was never a handful of one-off model quirks — `alter`
    // itself doesn't work reliably here, confirmed by checking `PRAGMA table_info` against a
    // live production DB copy for every model that hit this: every column/index each model
    // declares already existed in the actual table, meaning `alter` had nothing to legitimately
    // change and was crashing on a pure no-op. Plain `.sync()` still creates a table if it's
    // missing — it just never attempts to rebuild an existing one. Going forward, any new
    // column on ANY model needs a manual `ALTER TABLE` here, same as `users`/`content_meta`
    // already do below — that manual-migration convention is now the only supported path for
    // schema changes to an existing table, not the exception.
    // PERF INCIDENT (2026-07-17): every Discover browse/genre-row query
    // ORDER BY-s content_meta.enrichedAt, but no index existed for it — fine
    // for a plain single-table scan, but combined with a genre/country/theme
    // JOIN, SQLite couldn't use an index to jump straight to the top 40 rows
    // and instead had to materialize/sort a much larger joined result set,
    // which never completed in testing under real concurrent load. Also add
    // composite (value, contentId) indexes on the tag tables — the existing
    // single-column indexes on `value` and `contentId` separately don't help
    // SQLite satisfy "rows with this specific value, joined back for this
    // specific contentId" as efficiently as one index covering both.
    try {
      await sequelize.query("CREATE INDEX IF NOT EXISTS `idx_content_meta_enrichedAt` ON `content_meta` (`enrichedAt`);");
      logger.info("Migration: Ensured index on content_meta.enrichedAt.");
    } catch (e: any) {
      logger.error(`Migration: failed to create content_meta.enrichedAt index: ${e.message}`);
    }
    // PERF INCIDENT (2026-07-17): recomputeRepresentatives() below runs a
    // correlated subquery keyed on groupKey for every content_meta row on
    // every startup. With no index on groupKey, each of those ~100k+ lookups
    // was a full table scan — server startup (initDB is awaited before
    // server.start()) stalled indefinitely with no further log output,
    // making the whole server unreachable ("Failed to fetch" on login).
    try {
      await sequelize.query("CREATE INDEX IF NOT EXISTS `idx_content_meta_groupKey` ON `content_meta` (`groupKey`);");
      logger.info("Migration: Ensured index on content_meta.groupKey.");
    } catch (e: any) {
      logger.error(`Migration: failed to create content_meta.groupKey index: ${e.message}`);
    }
    for (const table of ["content_genres", "content_countries", "content_themes"]) {
      try {
        await sequelize.query(`CREATE INDEX IF NOT EXISTS \`idx_${table}_value_contentId\` ON \`${table}\` (\`value\`, \`contentId\`);`);
        logger.info(`Migration: Ensured composite (value, contentId) index on ${table}.`);
      } catch (e: any) {
        logger.error(`Migration: failed to create composite index on ${table}: ${e.message}`);
      }
    }

    for (const model of Object.values(sequelize.models)) {
      if (model.name === "UserProgress") continue; // fully hand-managed above, not even a plain sync
      try {
        await model.sync({ alter: false });
      } catch (e: any) {
        logger.error(`Failed to sync model "${model.name}" (table "${(model as any).tableName}"): ${e.message}`);
      }
    }
    logger.info("Database models synced.");

    try {
      // Recomputed on every startup regardless (cheap — two indexed queries),
      // since a fresh backfill or any enrichment-adjacent data change could
      // shift which row is the "best" representative per group.
      await recomputeRepresentatives();
      logger.info("Migration: Recomputed content_meta representative rows.");
    } catch (e: any) {
      logger.error(`Failed to backfill/recompute content_meta groupKey data: ${e.message}`);
    }

  } catch (error: any) {
    // Plain `${error}` on a SequelizeUniqueConstraintError/SequelizeValidationError only
    // stringifies to "SequelizeUniqueConstraintError: Validation error" — the actual
    // table/field/value detail lives in error.errors[], which template-literal coercion
    // silently drops. Log it explicitly so a sync failure is ever diagnosable from logs
    // alone instead of requiring a live repro.
    logger.error(`Unable to connect to the database: ${error}`);
    if (Array.isArray(error?.errors) && error.errors.length > 0) {
      for (const detail of error.errors) {
        logger.error(
          `  -> ${detail.type || detail.validatorKey || "detail"}: path=${detail.path} value=${JSON.stringify(detail.value)} ${detail.message || ""}`,
        );
      }
    }
    if (error?.parent) {
      logger.error(`  -> parent: ${error.parent.message || error.parent}`);
    }
    if (error?.stack) {
      logger.error(error.stack);
    }
  }
}
