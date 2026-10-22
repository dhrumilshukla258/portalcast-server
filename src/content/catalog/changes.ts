// Change capture for the catalog snapshot (plan, Phase 1 "Versions and small changes").
//
// SQLite triggers on every catalog table append the changed key to `catalog_changes` in the
// same transaction as the write, so no writer has to remember to report a change (raw SQL,
// migrations and the content manager included). One row per key (UNIQUE (tbl, key)) with its
// latest sequence number, so the log is bounded by the number of keys, not the number of
// writes. The highest sequence number is the catalog version.
//
// A trigger deletes the key's row and inserts a new one; it never relies on a conflict clause.
// SQLite applies the outer statement's conflict handling inside its triggers: under an upsert
// (`ON CONFLICT DO UPDATE`, what Sequelize upsert and xtreamCache.set send) an `INSERT OR
// REPLACE` in the trigger aborted the write itself, and under `INSERT OR IGNORE` it would have
// kept the old sequence number and lost the change (test/catalog-changes.test.ts).
//
// Installed only while the snapshot is on (setting `catalogSnapshot`); switched off, the
// triggers and the log are dropped, so no write pays for them.

import { QueryTypes, Sequelize } from "sequelize";

interface Source {
  table: string;
  /** Short name stored in the log. */
  tbl: string;
  /** SQL expression for the key, using NEW. or OLD. */
  key: (row: "NEW" | "OLD") => string;
  /** Optional WHEN condition (same row alias). */
  when?: (row: "NEW" | "OLD") => string;
}

const SOURCES: Source[] = [
  { table: "content_meta", tbl: "title", key: (r) => `${r}.id` },
  { table: "content_genres", tbl: "tags", key: (r) => `${r}.contentId` },
  { table: "content_countries", tbl: "tags", key: (r) => `${r}.contentId` },
  { table: "content_themes", tbl: "tags", key: (r) => `${r}.contentId` },
  { table: "people", tbl: "person", key: (r) => `CAST(${r}.id AS TEXT)` },
  { table: "title_people", tbl: "credits", key: (r) => `${r}.titleKey` },
  { table: "content_overrides", tbl: "override", key: (r) => `${r}.item_key` },
  { table: "genre_overrides", tbl: "genre_override", key: (r) => `${r}.genre_key` },
  { table: "genres", tbl: "genres", key: (r) => `${r}.id` },
  // Only the category lists, not every cached portal answer.
  {
    table: "xtream_cache", tbl: "list", key: (r) => `${r}.key`,
    when: (r) => `${r}.key GLOB 'vod_streams_*' OR ${r}.key GLOB 'series_list_*'`,
  },
];

const EVENTS = [
  { ev: "INSERT", rows: ["NEW"] as const },
  { ev: "UPDATE", rows: ["NEW", "OLD"] as const },
  { ev: "DELETE", rows: ["OLD"] as const },
];

const triggerName = (s: Source, ev: string) => `trg_catalog_${s.table}_${ev.toLowerCase()}`;

/** Creates (on) or drops (off) the log table and its triggers. Idempotent; on always
 *  recreates the triggers, so an older trigger body never stays installed. */
export async function setChangeCapture(db: Sequelize, on: boolean): Promise<void> {
  for (const s of SOURCES) for (const { ev } of EVENTS) await db.query(`DROP TRIGGER IF EXISTS \`${triggerName(s, ev)}\``);
  if (!on) {
    await db.query("DROP TABLE IF EXISTS `catalog_changes`");
    return;
  }
  await db.query(
    "CREATE TABLE IF NOT EXISTS `catalog_changes` (`seq` INTEGER PRIMARY KEY AUTOINCREMENT, `tbl` TEXT NOT NULL, `key` TEXT NOT NULL, `at` INTEGER NOT NULL, UNIQUE (`tbl`, `key`))",
  );
  for (const s of SOURCES) {
    for (const { ev, rows } of EVENTS) {
      // UPDATE logs both keys only when the key itself changed (rare: an id rename).
      const now = "CAST(strftime('%s','now') AS INTEGER) * 1000";
      const log = (key: string, cond = "") => [
        `DELETE FROM catalog_changes WHERE tbl = '${s.tbl}' AND key = ${key}${cond ? ` AND ${cond}` : ""};`,
        // A NULL key is skipped: logging must never be the reason a write fails.
        `INSERT INTO catalog_changes (tbl, key, at) SELECT '${s.tbl}', ${key}, ${now} WHERE ${key} IS NOT NULL${cond ? ` AND ${cond}` : ""};`,
      ];
      const inserts = rows.filter((r, i) => i === 0 || ev !== "UPDATE").flatMap((r) => log(s.key(r)));
      if (ev === "UPDATE") inserts.push(...log(s.key("OLD"), `${s.key("OLD")} IS NOT ${s.key("NEW")}`));
      const row = rows[0];
      const when = s.when ? ` WHEN ${s.when(row)}` : "";
      await db.query(
        `CREATE TRIGGER IF NOT EXISTS \`${triggerName(s, ev)}\` AFTER ${ev} ON \`${s.table}\` FOR EACH ROW${when} BEGIN ${inserts.join(" ")} END`,
      );
    }
  }
}

/** The catalog version: the highest change sequence number (0 when nothing was logged). */
export async function latestChange(db: Sequelize): Promise<number> {
  const [row] = (await db.query("SELECT IFNULL(MAX(seq), 0) AS v FROM catalog_changes", { type: QueryTypes.SELECT })) as any[];
  return Number(row?.v) || 0;
}

/** Changes after `since` (key and table), oldest first; capped. */
export async function changesSince(db: Sequelize, since: number, limit = 5000): Promise<{ seq: number; tbl: string; key: string }[]> {
  return (await db.query("SELECT seq, tbl, key FROM catalog_changes WHERE seq > ? ORDER BY seq LIMIT ?", {
    replacements: [since, limit], type: QueryTypes.SELECT,
  })) as any[];
}

/** Category list cache keys changed after `since` (every one: there are about 200 such keys). */
export async function listChangesSince(db: Sequelize, since: number): Promise<string[]> {
  const rows = (await db.query("SELECT key FROM catalog_changes WHERE tbl = 'list' AND seq > ?", {
    replacements: [since], type: QueryTypes.SELECT,
  })) as { key: string }[];
  return rows.map((r) => r.key);
}

/** Drops log entries older than `days` (devices older than that download the catalog again). */
export async function pruneChanges(db: Sequelize, days = 30): Promise<void> {
  await db.query("DELETE FROM catalog_changes WHERE at < ?", { replacements: [Date.now() - days * 86400_000] });
}
