// One-time storage migrations (speed plan, data model step). They run once, at startup,
// before the server listens, so nothing else touches the database meanwhile; each step is
// recorded in system_config and never runs again. A full copy of the database is saved
// first (services/backup.ts), so every step can be undone by restoring it.
//
// Measured on a copy of the live database (2026-10-21, 1.03 GB):
//  - 932,868 `ep_info_*` rows (three small numbers each) become one row each in the
//    compact `episode_index` table;
//  - `vod_cmd_*`, `ep_cmd_*` (written, never read since the Xtream emulation was removed),
//    `vod_info_*` (its two uses read the in-memory catalog now) and `tmdb_web_*` (the
//    catalog pages read content_meta now) are deleted;
//  - full raw TMDB answers for titles already enriched are deleted (content_meta holds
//    the facts; "not found" answers stay, so failed searches are never repeated);
//  - trailer keys move from the raw answers into content_meta first;
//  - expired whole-page answers (content_cache) and three unused tables are removed;
//  - values over 2 KB are compressed (services/xtreamCache.ts reads both forms);
//  - finally the file is compacted (VACUUM), returning the freed pages to the disk.

import zlib from "zlib";
import { promisify } from "util";
import { QueryTypes, Sequelize } from "sequelize";
import { logger } from "@/infra/logger";
import { SystemConfig } from "@/models/SystemConfig";
import { backupBeforeChange } from "@/services/backup";

const STEPS_KEY = "storage_migrations";
const deflateAsync = promisify(zlib.deflate);

type Step = { name: string; run: (db: Sequelize) => Promise<string> };

// Rows the previous statement changed (startup: nothing else runs on the connection meanwhile).
async function changedRows(db: Sequelize, run: () => Promise<unknown>): Promise<number> {
  await run();
  const [{ n }] = (await db.query("SELECT changes() AS n", { type: QueryTypes.SELECT })) as any[];
  return Number(n) || 0;
}

const STEPS: Step[] = [
  {
    name: "episode-index",
    run: async (db) => {
      // Only plain numeric ids, whose value is valid JSON with a numeric series id.
      await db.query(`
        INSERT OR REPLACE INTO episode_index (episodeId, seriesId, episode)
        SELECT CAST(substr(key, 9) AS INTEGER),
               CAST(json_extract(value, '$.movieId') AS INTEGER),
               CAST(json_extract(value, '$.seriesNum') AS INTEGER)
        FROM xtream_cache
        WHERE key GLOB 'ep_info_[0-9]*' AND NOT substr(key, 9) GLOB '*[^0-9]*'
          AND typeof(value) = 'text' AND json_valid(value)
          AND json_extract(value, '$.movieId') IS NOT NULL`);
      const [{ n }] = (await db.query("SELECT count(*) AS n FROM episode_index", { type: QueryTypes.SELECT })) as any[];
      const del = await changedRows(db, () => db.query("DELETE FROM xtream_cache WHERE key GLOB 'ep_info_*'"));
      return `${n} episodes indexed, ${del} ep_info rows removed`;
    },
  },
  {
    name: "trailer-keys",
    run: async (db) => {
      // From whichever raw TMDB answer has one: the enrichment's, else the catalog page's.
      const pick = (prefix: string, idExpr: string) =>
        `(SELECT json_extract(value, '$.trailerKey') FROM xtream_cache WHERE key = '${prefix}' || ${idExpr} AND typeof(value) = 'text' AND json_valid(value))`;
      const m = await changedRows(db, () => db.query(`
        UPDATE content_meta SET trailerKey = COALESCE(${pick("tmdb_movie_", "substr(id, 7)")}, ${pick("tmdb_web_movie_", "substr(id, 7)")})
        WHERE type = 'movie' AND trailerKey IS NULL AND id GLOB 'movie_[0-9]*'`));
      const s = await changedRows(db, () => db.query(`
        UPDATE content_meta SET trailerKey = COALESCE(${pick("tmdb_tv_", "substr(id, 8)")}, ${pick("tmdb_web_series_", "substr(id, 8)")})
        WHERE type = 'series' AND trailerKey IS NULL AND id GLOB 'series_[0-9]*'`));
      const [{ n }] = (await db.query("SELECT count(*) AS n FROM content_meta WHERE trailerKey IS NOT NULL", { type: QueryTypes.SELECT })) as any[];
      return `${n} titles have a trailer (${m + s} rows checked)`;
    },
  },
  {
    name: "dead-cache-keys",
    run: async (db) => {
      const del = await changedRows(db, () => db.query(
        "DELETE FROM xtream_cache WHERE key GLOB 'vod_cmd_*' OR key GLOB 'ep_cmd_*' OR key GLOB 'vod_info_*' OR key GLOB 'tmdb_web_*'",
      ));
      return `${del} rows removed`;
    },
  },
  {
    name: "raw-tmdb-answers",
    run: async (db) => {
      // Full answers of titles whose facts content_meta already holds. `tmdb_tv_[0-9]*`
      // leaves the per-season episode caches (tmdb_tv_season_*) alone.
      const m = await changedRows(db, () => db.query(`
        DELETE FROM xtream_cache
        WHERE key GLOB 'tmdb_movie_[0-9]*' AND NOT substr(key, 12) GLOB '*[^0-9]*'
          AND NOT (typeof(value) = 'text' AND value LIKE '%"_not_found"%')
          AND EXISTS (SELECT 1 FROM content_meta c WHERE c.id = 'movie_' || substr(xtream_cache.key, 12) AND c.enrichedAt IS NOT NULL)`));
      const s = await changedRows(db, () => db.query(`
        DELETE FROM xtream_cache
        WHERE key GLOB 'tmdb_tv_[0-9]*' AND NOT substr(key, 9) GLOB '*[^0-9]*'
          AND NOT (typeof(value) = 'text' AND value LIKE '%"_not_found"%')
          AND EXISTS (SELECT 1 FROM content_meta c WHERE c.id = 'series_' || substr(xtream_cache.key, 9) AND c.enrichedAt IS NOT NULL)`));
      return `${m + s} rows removed`;
    },
  },
  {
    name: "expired-page-answers",
    run: async (db) => {
      const del = await changedRows(db, () => db.query("DELETE FROM content_cache WHERE expiresAt < ?", { replacements: [new Date().toISOString()] }));
      return `${del} rows removed`;
    },
  },
  {
    name: "unused-tables",
    run: async (db) => {
      for (const t of ["content_meta_backup", "strm_movies", "strm_series"]) await db.query(`DROP TABLE IF EXISTS \`${t}\``);
      return "content_meta_backup, strm_movies, strm_series dropped";
    },
  },
  {
    name: "compress-cache",
    run: async (db) => {
      let done = 0, before = 0, after = 0;
      for (;;) {
        const rows = (await db.query(
          "SELECT key, value FROM xtream_cache WHERE typeof(value) = 'text' AND length(value) >= 2048 LIMIT 200",
          { type: QueryTypes.SELECT },
        )) as { key: string; value: string }[];
        if (rows.length === 0) break;
        const packed = await Promise.all(rows.map(async (r) => ({ key: r.key, raw: r.value, z: await deflateAsync(Buffer.from(r.value, "utf8"), { level: 6 }) })));
        await db.transaction(async (transaction) => {
          for (const p of packed) {
            await db.query("UPDATE xtream_cache SET value = ? WHERE key = ?", { replacements: [p.z, p.key], transaction });
          }
        });
        for (const p of packed) { before += Buffer.byteLength(p.raw); after += p.z.length; }
        done += rows.length;
      }
      return `${done} values compressed, ${(before / 1048576).toFixed(0)} MB to ${(after / 1048576).toFixed(0)} MB`;
    },
  },
  {
    name: "vacuum",
    run: async (db) => {
      const pages = async () => ((await db.query("PRAGMA page_count", { type: QueryTypes.SELECT })) as any[])[0].page_count as number;
      const b = await pages();
      await db.query("VACUUM");
      const a = await pages();
      return `file compacted: ${((b * 4096) / 1048576).toFixed(0)} MB to ${((a * 4096) / 1048576).toFixed(0)} MB`;
    },
  },
];

/** Runs every step not run yet; a failing step stops the rest (they retry next start). */
export async function runStorageMigrations(db: Sequelize): Promise<void> {
  const row = await SystemConfig.findByPk(STEPS_KEY);
  const done = new Set<string>(Array.isArray(row?.value) ? (row!.value as string[]) : []);
  const todo = STEPS.filter((s) => !done.has(s.name));
  if (todo.length === 0) return;
  logger.info(`[storage] ${todo.length} one-time storage step(s) to run; saving a copy of the database first`);
  if (!(await backupBeforeChange("storage-migration"))) {
    logger.error("[storage] no backup could be saved: storage steps skipped until one can be");
    return;
  }
  for (const step of todo) {
    const t0 = Date.now();
    try {
      const result = await step.run(db);
      done.add(step.name);
      await SystemConfig.upsert({ key: STEPS_KEY, value: [...done] });
      logger.info(`[storage] ${step.name}: ${result} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e: any) {
      logger.error(`[storage] ${step.name} failed, the rest wait for the next start: ${e?.message ?? e}`);
      return;
    }
  }
}
