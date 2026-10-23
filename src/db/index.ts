import { Library } from "../models/Library";
import { LocalItem } from "../models/LocalItem";
import { MediaFile } from "../models/MediaFile";
import { databasePath } from "../infra/paths";
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
import { User } from "../models/User";
import { DeviceCode } from "../models/DeviceCode";
import { UserProgress } from "../models/UserProgress";
import { ContentCache } from "../models/ContentCache";
import { ContentMeta } from "../models/ContentMeta";
import { ContentGenre } from "../models/ContentGenre";
import { recomputeRepresentatives } from "../content/metaEnrichment";
import { ContentCountry } from "../models/ContentCountry";
import { ContentTheme } from "../models/ContentTheme";
import { StreamFailure } from "../models/StreamFailure";
import { MediaInfo } from "../models/MediaInfo";
import { SubtitleFile } from "../models/SubtitleFile";
import { SecurityEvent } from "../models/SecurityEvent";
import { RefreshToken } from "../models/RefreshToken";
import { logger } from "../infra/logger";

// The database file and data folder are resolved in infra/paths.ts (shared with uploads,
// the generated key file and backups).
export { databasePath };

export const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: databasePath,
  models: [
    Token, SystemConfig, ConfigProfile, Channel, Genre, EpgCache,
    XtreamCache, GenreOverride, ContentOverride,
    User, DeviceCode, UserProgress, ContentCache,
    ContentMeta, ContentGenre, ContentCountry, ContentTheme,
    StreamFailure, MediaInfo, SubtitleFile, SecurityEvent, RefreshToken,
    Library, LocalItem, MediaFile,
  ],
  logging: false,
});

// Every transaction gets its OWN SQLite connection (sequelize's sqlite ConnectionManager keys
// connections by the transaction id; only plain queries share "default"), so a PRAGMA run once
// reaches only the default connection. Busy wait per connection, set here as each one opens:
// without it a transaction meeting another writer failed with SQLITE_BUSY almost at once.
{
  const cm = sequelize.connectionManager as any;
  const getConnection = cm.getConnection.bind(cm);
  cm.getConnection = async (options: any) => {
    const connection = await getConnection(options);
    if (!connection.__busyTimeoutSet) {
      connection.configure("busyTimeout", 5000);
      connection.__busyTimeoutSet = true;
      // The database is ~1 GB: SQLite's default page cache (~2 MB) sent most reads to disk.
      // 32 MB cache and a 256 MB memory map per connection (memory is only used as pages are
      // read); NORMAL sync is safe with WAL (a power cut can lose the last commit, never
      // corrupt the file); temp tables (recomputeRepresentatives) in memory.
      await new Promise<void>((resolve) =>
        connection.exec("PRAGMA cache_size=-32768; PRAGMA mmap_size=268435456; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;", (err: any) => {
          if (err) logger.warn(`SQLite connection settings failed: ${err.message ?? err}`);
          resolve();
        }),
      );
    }
    return connection;
  };
}

/** ALTER TABLE ... ADD COLUMN for each column the table is missing (idempotent). */
async function ensureColumns(table: string, columns: [string, string][]): Promise<void> {
  try {
    const [rows] = (await sequelize.query(`PRAGMA table_info('${table}');`)) as any;
    const have = new Set((rows as any[]).map((r) => r.name));
    for (const [name, type] of columns) {
      if (have.has(name)) continue;
      await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${type};`);
      logger.info(`Migration: added ${table}.${name}`);
    }
  } catch (e: any) {
    logger.error(`Migration: could not add columns to ${table}: ${e.message}`);
  }
}

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
    // to 5s before giving up. This only reaches the default connection;
    // transaction connections get the same wait where they open (above,
    // after `new Sequelize`).
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

    // My List (content/myList.ts, the only writer): titles a viewer saved, one row per title.
    try {
      await sequelize.query(
        "CREATE TABLE IF NOT EXISTS `user_list` (`userId` INTEGER NOT NULL, `profileId` INTEGER NOT NULL, `contentId` VARCHAR(255) NOT NULL, `addedAt` INTEGER NOT NULL, PRIMARY KEY (`userId`, `profileId`, `contentId`));",
      );
    } catch (e: any) {
      logger.error(`Migration: failed to ensure user_list: ${e.message}`);
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
    // Covering index for the in-memory Discover index load (content/discoverIndex.ts):
    // "representative rows, newest first, with id/type/language" is answered from this
    // index alone. Without it the load read ~94k wide rows (cast, artwork URLs): 7–10 s on
    // the live data, against 1.6 s with it. One-time build ~1–3 s on the first start.
    try {
      await sequelize.query("CREATE INDEX IF NOT EXISTS `idx_content_meta_discover` ON `content_meta` (`isRepresentative`, `enrichedAt`, `id`, `type`, `originalLanguage`);");
    } catch (e: any) {
      logger.error(`Migration: failed to create content_meta discover index: ${e.message}`);
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
        // UNIQUE: a title carries each tag once (content/tags.ts; "unique-tags" storage step).
        await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS \`idx_${table}_value_contentId\` ON \`${table}\` (\`value\`, \`contentId\`);`);
        logger.info(`Migration: Ensured composite (value, contentId) index on ${table}.`);
      } catch (e: any) {
        logger.error(`Migration: failed to create composite index on ${table}: ${e.message}`);
      }
    }
    // Indexes that only cost writes (speed plan step 3): exact duplicates of the idx_* ones
    // above (groupKey, enrichedAt), `value` alone (the composite (value, contentId) covers it),
    // and isRepresentative (content_meta: covered by idx_content_meta_discover; tag tables:
    // ~80% of rows are representative, a scan beats the index). The models no longer declare them.
    for (const name of [
      "content_meta_group_key", "content_meta_enriched_at", "content_meta_is_representative",
      "content_genres_value", "content_countries_value", "content_themes_value",
      "content_genres_is_representative", "content_countries_is_representative", "content_themes_is_representative",
    ]) {
      try {
        await sequelize.query(`DROP INDEX IF EXISTS \`${name}\`;`);
      } catch (e: any) {
        logger.error(`Migration: could not drop index ${name}: ${e.message}`);
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

    // sync() never alters an existing table (see above): add missing columns by hand.
    await ensureColumns("content_meta", [["overview", "TEXT"], ["rating", "FLOAT"], ["ratingCount", "INTEGER"],
      ["imdbId", "VARCHAR(255)"], ["imdbRating", "FLOAT"], ["imdbVotes", "INTEGER"],
      ["rtRating", "VARCHAR(255)"], ["metascore", "INTEGER"], ["omdbCheckedAt", "DATETIME"], ["ratingsCheckedAt", "DATETIME"]]);
    // The daily IMDb ratings update and OMDb match rows by IMDb id: without an index each
    // of ~100k updates would scan the whole table.
    await sequelize.query("CREATE INDEX IF NOT EXISTS `idx_content_meta_imdbId` ON `content_meta` (`imdbId`);");
    // Local library (models/MediaFile.ts): episode columns added after the table first shipped.
    await ensureColumns("local_items", [["art", "JSON"], ["nfo", "JSON"]]);
    await ensureColumns("content_meta", [
      ["tagline", "TEXT"], ["ageRating", "VARCHAR(255)"], ["runtime", "INTEGER"], ["studios", "TEXT"],
      ["collection", "VARCHAR(255)"], ["originalTitle", "VARCHAR(255)"], ["premiered", "VARCHAR(255)"],
      ["logo", "VARCHAR(255)"], ["writers", "TEXT"], ["detailsCheckedAt", "DATETIME"], ["artLocked", "JSON"],
      ["trailerKey", "VARCHAR(255)"],
      // The provider's own date (unix seconds): a movie's added, a series' last_modified
      // (content/providerDates.ts). Home's Just added and New episodes.
      ["providerAddedAt", "INTEGER"],
      // A series' newest episode (unix seconds), for the series viewers follow
      // (content/episodeWatch.ts). Home's New episodes.
      ["providerEpisodeAt", "INTEGER"],
      // "Fix match" on a portal title (content/metaEnrichment.ts fixPortalMatch).
      ["tmdbIdLocked", "INTEGER"],
    ]);
    // Cast and crew stored once (content/people.ts), replacing content_people.
    await sequelize.query(
      "CREATE TABLE IF NOT EXISTS `people` (`id` INTEGER PRIMARY KEY, `tmdbPersonId` INTEGER UNIQUE, `name` TEXT NOT NULL, `photo` TEXT)",
    );
    await sequelize.query(
      "CREATE TABLE IF NOT EXISTS `title_people` (`titleKey` TEXT NOT NULL, `personId` INTEGER NOT NULL, `kind` TEXT NOT NULL, `role` TEXT, `sortOrder` INTEGER NOT NULL)",
    );
    // UNIQUE: one credit per (title, kind, person, role) ("unique-credits" storage step).
    await sequelize.query("CREATE UNIQUE INDEX IF NOT EXISTS `idx_title_people_title` ON `title_people` (`titleKey`, `kind`, `personId`, IFNULL(`role`, ''))");
    await sequelize.query("CREATE INDEX IF NOT EXISTS `idx_title_people_person` ON `title_people` (`personId`)");
    // Name lookups (a name-only credit matched to its TMDB person) without reading 412k rows.
    await sequelize.query("CREATE INDEX IF NOT EXISTS `idx_people_name` ON `people` (`name`)");
    // Person pages (content/people.ts personPage): details fetched from TMDB on first open.
    await ensureColumns("people", [
      ["biography", "TEXT"], ["knownFor", "VARCHAR(64)"], ["birthday", "VARCHAR(16)"], ["deathday", "VARCHAR(16)"],
      ["placeOfBirth", "VARCHAR(255)"], ["detailsCheckedAt", "DATETIME"],
      // TMDB's gender: 1 female, 2 male, 3 non-binary, 0 TMDB has none; NULL not asked yet
      // (content/peopleGender.ts fills it in). For the People tab's Actors / Actresses.
      ["gender", "INTEGER"],
    ]);
    // A person's titles are found by TMDB id ("movie:<tmdbId>" keys).
    await sequelize.query("CREATE INDEX IF NOT EXISTS `idx_content_meta_type_tmdb` ON `content_meta` (`type`, `tmdbId`)");
    // Episode id -> series (content/episodeIndex.ts), replacing ep_info_* rows of xtream_cache.
    await sequelize.query(
      "CREATE TABLE IF NOT EXISTS `episode_index` (`episodeId` INTEGER PRIMARY KEY, `seriesId` INTEGER NOT NULL, `episode` INTEGER)",
    );
    await ensureColumns("media_files", [["nfo", "JSON"], ["thumb", "TEXT"], ["keyframes", "JSON"]]);
    await ensureColumns("media_files", [["season", "INTEGER"], ["episode", "INTEGER"], ["episodeEnd", "INTEGER"], ["episodeTitle", "VARCHAR(255)"]]);
    await ensureColumns("users", [
      ["openSubtitlesUsername", "VARCHAR(255)"],
      ["openSubtitlesPasswordEnc", "TEXT"],
      ["openSubtitlesApiKeyEnc", "TEXT"],
      ["subdlApiKeyEnc", "TEXT"],
    ]);

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
