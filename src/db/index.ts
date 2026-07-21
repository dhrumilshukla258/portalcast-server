import fs from "fs";
import { Sequelize } from "sequelize-typescript";
import { Op } from "sequelize";
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
import { COUNTRY_NAMES } from "../content/countryNames";
import { normalizeTitleKey, stripReleaseNoise } from "../content/titleClean";
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

    // Migrate content_cache: drop old table if it has the wrong PK (auto-increment id instead of cacheKey)
    try {
      const [columns] = await sequelize.query("PRAGMA table_info('content_cache');") as any;
      if (columns && columns.length > 0) {
        const pkColumn = columns.find((c: any) => c.pk === 1);
        if (pkColumn && pkColumn.name !== "cacheKey") {
          logger.warn("Migration: content_cache has wrong PK — dropping and recreating. All cached API responses will be lost.");
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
          logger.warn("Migration: user_progress lacks profileId column — dropping and recreating. All watch history will be lost.");
          await sequelize.query("DROP TABLE `user_progress`;");
        }
      }
    } catch {
      // Table may not exist yet
    }

    // Migrate: drop stale `user_progress_backup` if present — leftover from a prior,
    // never-completed migration attempt. Only ever drop it when empty; if it somehow has
    // real rows, leave it alone and log loudly instead of guessing what to do with someone's data.
    try {
      const [rows] = await sequelize.query("SELECT COUNT(*) as count FROM `user_progress_backup`;") as any;
      const count = rows?.[0]?.count ?? 0;
      if (count === 0) {
        logger.warn("Migration: dropping empty stale `user_progress_backup` table (leftover from a prior migration attempt).");
        await sequelize.query("DROP TABLE `user_progress_backup`;");
      } else {
        logger.error(`Migration: \`user_progress_backup\` exists with ${count} row(s) — NOT auto-dropping.`);
      }
    } catch {
      // Table doesn't exist — nothing to do, this is the expected/healthy case
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
    // Tables excluded from `alter` entirely (plain `.sync()` — still creates the table if
    // missing, never attempts to rebuild an existing one): UserProgress (hand-managed above,
    // composite-PK-via-3-@PrimaryKey-decorators corrupts on alter) and the four Discover
    // tables added this session (ContentMeta + its three FK-child tag tables). The Discover
    // tables hit the *same class* of bug on a live deploy once real data existed: Sequelize's
    // SQLite alter-via-rebuild-copy needs to DROP the original table mid-rebuild, and
    // content_genres/content_countries/content_themes rows holding live FK references to
    // content_meta.id blocked that drop with "FOREIGN KEY constraint failed" — a second
    // manifestation of the same root problem (alter-via-rebuild is unreliable for SQLite
    // tables with PK/FK relationships), not a one-off. Since these are brand-new tables with
    // no legacy schema baggage, skipping alter costs nothing today; any future column
    // addition to these models needs a manual `ALTER TABLE` here, same as `users`/`user_progress`.
    // Column additions for the NO_ALTER_MODELS tag tables MUST run before the
    // sync loop below, not after — even with alter:false, Sequelize's sync()
    // still tries to (re)create each model's declared indexes, including on
    // brand-new columns like isRepresentative. If the column doesn't exist in
    // the actual table yet, that index-creation throws "no such column"
    // (harmless — the ALTER TABLE below still runs and fixes it moments
    // later — but it's needless error-log noise on every fresh deploy that
    // adds a column here). Doing this first avoids the error entirely.
    try {
      await sequelize.query("ALTER TABLE `content_meta` ADD COLUMN `groupKey` TEXT;");
      logger.info("Migration: Added groupKey column to content_meta table.");
    } catch {
      // Column already exists — expected
    }
    try {
      await sequelize.query("ALTER TABLE `content_meta` ADD COLUMN `isRepresentative` INTEGER DEFAULT 0;");
      logger.info("Migration: Added isRepresentative column to content_meta table.");
    } catch {
      // Column already exists — expected
    }
    try {
      await sequelize.query("ALTER TABLE `content_meta` ADD COLUMN `trimmedName` TEXT;");
      logger.info("Migration: Added trimmedName column to content_meta table.");
    } catch {
      // Column already exists — expected
    }
    try {
      await sequelize.query("ALTER TABLE `content_meta` ADD COLUMN `portalCategoryId` TEXT;");
      logger.info("Migration: Added portalCategoryId column to content_meta table.");
    } catch {
      // Column already exists — expected
    }
    try {
      await sequelize.query("ALTER TABLE `content_meta` ADD COLUMN `backdrop` TEXT;");
      logger.info("Migration: Added backdrop column to content_meta table.");
    } catch {
      // Column already exists — expected
    }
    try {
      await sequelize.query("ALTER TABLE `content_meta` ADD COLUMN `backdropHd` TEXT;");
      logger.info("Migration: Added backdropHd column to content_meta table.");
    } catch {
      // Column already exists — expected
    }
    try {
      await sequelize.query("ALTER TABLE `content_meta` ADD COLUMN `cast` TEXT;");
      logger.info("Migration: Added cast column to content_meta table.");
    } catch {
      // Column already exists — expected
    }
    try {
      await sequelize.query("ALTER TABLE `content_meta` ADD COLUMN `director` TEXT;");
      logger.info("Migration: Added director column to content_meta table.");
    } catch {
      // Column already exists — expected
    }
    // Denormalized copy on the tag tables too — see ContentGenre.ts for why
    // (avoids ever joining back to content_meta just to filter this).
    for (const table of ["content_genres", "content_countries", "content_themes"]) {
      try {
        await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`isRepresentative\` INTEGER DEFAULT 0;`);
        logger.info(`Migration: Added isRepresentative column to ${table} table.`);
      } catch {
        // Column already exists — expected
      }
    }

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

    const NO_ALTER_MODELS = new Set(["UserProgress", "ContentMeta", "ContentGenre", "ContentCountry", "ContentTheme"]);
    for (const model of Object.values(sequelize.models)) {
      if (model.name === "UserProgress") continue; // fully hand-managed above, not even a plain sync
      try {
        await model.sync({ alter: !NO_ALTER_MODELS.has(model.name) });
      } catch (e: any) {
        logger.error(`Failed to sync model "${model.name}" (table "${(model as any).tableName}"): ${e.message}`);
      }
    }
    logger.info("Database models synced.");

    // Auto-migrate schema: Add passwordHash and salt columns if they do not exist
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `passwordHash` TEXT;");
      logger.info("Migration: Added passwordHash column to users table.");
    } catch {
      // Column already exists — expected
    }
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `salt` TEXT;");
      logger.info("Migration: Added salt column to users table.");
    } catch {
      // Column already exists — expected
    }
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `avatarUrl` TEXT;");
      logger.info("Migration: Added avatarUrl column to users table.");
    } catch {
      // Column already exists — expected
    }

    // One-time backfill: groupKey/trimmedName are only ever set going forward
    // by metaEnrichment.ts's upsertContent(); existing rows from before each
    // of those columns existed need them computed once from their existing
    // `name`. `Op.or` catches rows missing either one — trimmedName was added
    // after groupKey, so plenty of rows already have groupKey set but not
    // trimmedName. Idempotent — only rows still missing something are
    // touched, so this is a no-op after the first successful run per column.
    // Sequential batches (not one big Promise.all) to avoid hammering the
    // same sqlite3 threadpool the Discover concurrency fix was just about —
    // this is a background one-time cost, not latency-sensitive like a page load.
    try {
      const unbackfilled = await ContentMeta.findAll({
        where: { [Op.or]: [{ groupKey: null as any }, { trimmedName: null as any }] },
        attributes: ["id", "name", "type", "year"],
        raw: true,
      });
      if (unbackfilled.length > 0) {
        logger.info(`Migration: Backfilling groupKey/trimmedName for ${unbackfilled.length} content_meta rows...`);
        const BATCH_SIZE = 100;
        for (let i = 0; i < unbackfilled.length; i += BATCH_SIZE) {
          const batch = unbackfilled.slice(i, i + BATCH_SIZE) as unknown as { id: string; name: string; type: string; year: string | null }[];
          await Promise.all(
            batch.map((row) =>
              ContentMeta.update(
                { groupKey: `${row.type}:${normalizeTitleKey(row.name)}:${row.year || ""}`, trimmedName: stripReleaseNoise(row.name) },
                { where: { id: row.id } },
              ),
            ),
          );
        }
        logger.info("Migration: groupKey/trimmedName backfill complete.");
      }
      // One-time fix for groupKey values set before type-scoping existed
      // (see metaEnrichment.ts's upsertContent) — a movie and series sharing
      // the same title used to collide into one groupKey, and
      // /discover/variants would then offer them as if they were
      // language/format "variants" of each other (confirmed: a real report
      // of a movie and a series both named "Ride or Die" showing up bundled
      // together). Idempotent — the NOT LIKE guard skips rows already
      // prefixed, safe to run every startup.
      try {
        await sequelize.query(
          "UPDATE `content_meta` SET `groupKey` = `type` || ':' || `groupKey` WHERE `groupKey` IS NOT NULL AND `groupKey` NOT LIKE (`type` || ':%');"
        );
        logger.info("Migration: Ensured content_meta.groupKey is type-scoped.");
      } catch (e: any) {
        logger.error(`Migration: failed to type-scope groupKey: ${e.message}`);
      }
      // Same reasoning, different axis: two unrelated shows can reuse the same
      // title years apart (e.g. "Bodies" 2004 vs. "Bodies" 2023) — without a
      // year suffix they'd collide into one groupKey and get offered as
      // "variants" of each other too. Appends `:year` (or a bare trailing `:`
      // when year is unknown) — idempotent via the NOT LIKE guard, same
      // pattern as the type-scoping migration above.
      try {
        await sequelize.query(
          "UPDATE `content_meta` SET `groupKey` = `groupKey` || ':' || COALESCE(`year`, '') WHERE `groupKey` IS NOT NULL AND `groupKey` NOT LIKE ('%:' || COALESCE(`year`, ''));"
        );
        logger.info("Migration: Ensured content_meta.groupKey is year-scoped.");
      } catch (e: any) {
        logger.error(`Migration: failed to year-scope groupKey: ${e.message}`);
      }
      // Recomputed on every startup regardless (cheap — two indexed queries),
      // since a fresh backfill or any enrichment-adjacent data change could
      // shift which row is the "best" representative per group.
      await recomputeRepresentatives();
      logger.info("Migration: Recomputed content_meta representative rows.");
    } catch (e: any) {
      logger.error(`Failed to backfill/recompute content_meta groupKey data: ${e.message}`);
    }

    // One-time data fix: series tagged before tmdb.ts's countryLabel() fix
    // stored raw ISO 3166-1 alpha-2 codes (e.g. "IN", "GB") instead of full
    // country names, so the same country showed up twice under two different
    // spellings depending on whether a movie or a series tagged it first.
    // Idempotent — once a row's value is the full name it no longer matches
    // any code key here, so re-running this on every startup is a no-op.
    try {
      for (const [code, name] of Object.entries(COUNTRY_NAMES)) {
        await sequelize.query(
          "UPDATE `content_countries` SET `value` = :name WHERE `value` = :code",
          { replacements: { code, name } },
        );
      }
      logger.info("Migration: Normalized ISO country codes in content_countries to full names.");
    } catch (e: any) {
      logger.error(`Failed to normalize content_countries codes: ${e.message}`);
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
