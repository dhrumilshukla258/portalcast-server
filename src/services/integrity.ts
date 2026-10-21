// Nightly data integrity check (plan: "Stop duplication at the source"). Counts what should
// never exist, repairs what is safe to repair, and keeps the result for admin Overview.
//
// The counts run on their own read-only SQLite connection, so a full scan of title_people
// (1.17M rows, about a second) never holds up the app's queries. Repairs go through the
// modules that own those tables (content/tags.ts, content/people.ts).
//
// The UNIQUE indexes make repeated tags and credits impossible; they are still counted, so a
// missing index (a database restored from an old backup) shows up instead of going unnoticed.

import sqlite3 from "sqlite3";
import { databasePath } from "@/infra/paths";
import { logger } from "@/infra/logger";
import { removeOrphanTags } from "@/content/tags";
import { mergeNameOnlyPeople } from "@/content/people";

export interface IntegrityReport {
  at: string;
  /** Problems left after the repairs: shown in admin Overview when above zero. */
  issues: number;
  counts: {
    repeatedTags: number;
    repeatedCredits: number;
    orphanTags: number;
    nameOnlyDuplicates: number;
    /** Not a problem by itself: titles kept apart on purpose (unconfirmed matches). */
    splitTitles: number;
  };
  repaired: { orphanTags: number; nameOnlyDuplicates: number };
}

let last: IntegrityReport | null = null;

/** The last report (null until the job has run once since start). */
export function lastIntegrity(): IntegrityReport | null {
  return last;
}

const COUNTS = {
  repeatedTags: `SELECT
      (SELECT COUNT(*) - COUNT(DISTINCT contentId || '|' || value) FROM content_genres)
    + (SELECT COUNT(*) - COUNT(DISTINCT contentId || '|' || value) FROM content_countries)
    + (SELECT COUNT(*) - COUNT(DISTINCT contentId || '|' || value) FROM content_themes) AS n`,
  repeatedCredits: `SELECT COUNT(*) - (SELECT COUNT(*) FROM (SELECT 1 FROM title_people GROUP BY titleKey, kind, personId, IFNULL(role, ''))) AS n FROM title_people`,
  orphanTags: `SELECT
      (SELECT COUNT(*) FROM content_genres WHERE contentId NOT IN (SELECT id FROM content_meta))
    + (SELECT COUNT(*) FROM content_countries WHERE contentId NOT IN (SELECT id FROM content_meta))
    + (SELECT COUNT(*) FROM content_themes WHERE contentId NOT IN (SELECT id FROM content_meta)) AS n`,
  // Same rule as content/people.ts uniqueTmdbPersonByName: a two-word-or-longer name that
  // exactly one TMDB person carries.
  nameOnlyDuplicates: `SELECT COUNT(*) AS n FROM people a
    WHERE a.tmdbPersonId IS NULL AND instr(trim(a.name), ' ') > 0
      AND (SELECT COUNT(*) FROM people b WHERE b.name = a.name AND b.tmdbPersonId IS NOT NULL) = 1`,
  splitTitles: `SELECT COUNT(*) AS n FROM (SELECT 1 FROM content_meta WHERE tmdbId IS NOT NULL
    GROUP BY type, tmdbId HAVING COUNT(DISTINCT COALESCE(groupKey, id)) > 1)`,
};

type CountName = keyof typeof COUNTS;

function readCounts(): Promise<Record<CountName, number>> {
  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) return reject(openErr);
      conn.configure("busyTimeout", 5000);
      const out = {} as Record<CountName, number>;
      const names = Object.keys(COUNTS) as CountName[];
      const next = (i: number) => {
        if (i === names.length) return conn.close(() => resolve(out));
        const name = names.at(i)!;
        conn.get(COUNTS[name], (err, row: any) => {
          if (err) return conn.close(() => reject(err));
          out[name] = Number(row?.n) || 0;
          next(i + 1);
        });
      };
      next(0);
    });
  });
}

/** The job: count, repair what is safe, count again. Returns its one-line summary. */
export async function runIntegrityCheck(): Promise<string> {
  const before = await readCounts();
  const repaired = { orphanTags: 0, nameOnlyDuplicates: 0 };
  if (before.orphanTags > 0) repaired.orphanTags = await removeOrphanTags();
  if (before.nameOnlyDuplicates > 0) repaired.nameOnlyDuplicates = await mergeNameOnlyPeople();
  const after = repaired.orphanTags || repaired.nameOnlyDuplicates ? await readCounts() : before;
  const issues = after.repeatedTags + after.repeatedCredits + after.orphanTags + after.nameOnlyDuplicates;
  last = { at: new Date().toISOString(), issues, counts: after, repaired };
  const summary =
    `${issues} problem(s) left; repaired ${repaired.orphanTags} orphan tags, ${repaired.nameOnlyDuplicates} duplicate persons; ` +
    `repeated tags ${after.repeatedTags}, repeated credits ${after.repeatedCredits}, split titles ${after.splitTitles} (by design)`;
  if (issues > 0) logger.warn(`[integrity] ${summary}`);
  return summary;
}
