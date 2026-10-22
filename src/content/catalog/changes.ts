// Change capture for the catalog snapshot (plan, Phase 1 "Versions and small changes").
//
// SQLite triggers on every catalog table append the changed key to `catalog_changes` in the
// same transaction as the write, so no writer has to remember to report a change (raw SQL,
// migrations and the content manager included). `INSERT OR REPLACE` on UNIQUE (tbl, key) keeps
// one row per key with its latest sequence number, so the log is bounded by the number of
// keys, not the number of writes. The highest sequence number is the catalog version.
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

/** Creates (on) or drops (off) the log table and its triggers. Idempotent. */
export async function setChangeCapture(db: Sequelize, on: boolean): Promise<void> {
  if (!on) {
    for (const s of SOURCES) for (const { ev } of EVENTS) await db.query(`DROP TRIGGER IF EXISTS \`${triggerName(s, ev)}\``);
    await db.query("DROP TABLE IF EXISTS `catalog_changes`");
    return;
  }
  await db.query(
    "CREATE TABLE IF NOT EXISTS `catalog_changes` (`seq` INTEGER PRIMARY KEY AUTOINCREMENT, `tbl` TEXT NOT NULL, `key` TEXT NOT NULL, `at` INTEGER NOT NULL, UNIQUE (`tbl`, `key`))",
  );
  for (const s of SOURCES) {
    for (const { ev, rows } of EVENTS) {
      // UPDATE logs both keys only when the key itself changed (rare: an id rename).
      const inserts = rows
        .filter((r, i) => i === 0 || ev !== "UPDATE")
        .map((r) => `INSERT OR REPLACE INTO catalog_changes (tbl, key, at) VALUES ('${s.tbl}', ${s.key(r)}, CAST(strftime('%s','now') AS INTEGER) * 1000);`);
      if (ev === "UPDATE") {
        inserts.push(
          `INSERT OR REPLACE INTO catalog_changes (tbl, key, at) SELECT '${s.tbl}', ${s.key("OLD")}, CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE ${s.key("OLD")} IS NOT ${s.key("NEW")};`,
        );
      }
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

/** Drops log entries older than `days` (devices older than that download the catalog again). */
export async function pruneChanges(db: Sequelize, days = 30): Promise<void> {
  await db.query("DELETE FROM catalog_changes WHERE at < ?", { replacements: [Date.now() - days * 86400_000] });
}
