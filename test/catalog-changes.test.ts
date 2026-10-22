import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { QueryTypes, Sequelize } from "sequelize";
import { setChangeCapture, latestChange, listChangesSince } from "../src/content/catalog/changes";

// Change capture under every write form the code uses on the captured tables. SQLite applies
// the outer statement's conflict handling inside triggers, so each form is exercised for real.

async function makeDb(): Promise<Sequelize> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-changes-"));
  const db = new Sequelize({ dialect: "sqlite", storage: path.join(dir, "t.db"), logging: false });
  for (const sql of [
    "CREATE TABLE content_meta (id TEXT PRIMARY KEY, name TEXT)",
    "CREATE TABLE content_genres (contentId TEXT, value TEXT)",
    "CREATE UNIQUE INDEX u_genres ON content_genres (value, contentId)",
    "CREATE TABLE content_countries (contentId TEXT, value TEXT)",
    "CREATE TABLE content_themes (contentId TEXT, value TEXT)",
    "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, tmdbPersonId INTEGER UNIQUE)",
    "CREATE TABLE title_people (titleKey TEXT, personId INTEGER)",
    "CREATE TABLE content_overrides (item_key TEXT UNIQUE, hidden INTEGER)",
    "CREATE TABLE genre_overrides (genre_key TEXT UNIQUE, hidden INTEGER)",
    "CREATE TABLE genres (id TEXT PRIMARY KEY, title TEXT)",
    "CREATE TABLE xtream_cache (key TEXT PRIMARY KEY, value BLOB, expiresAt DATETIME)",
  ]) await db.query(sql);
  await setChangeCapture(db, true);
  return db;
}

const log = async (db: Sequelize) =>
  (await db.query("SELECT seq, tbl, key FROM catalog_changes ORDER BY seq", { type: QueryTypes.SELECT })) as { seq: number; tbl: string; key: string }[];
const seqOf = async (db: Sequelize, tbl: string, key: string) => (await log(db)).find((r) => r.tbl === tbl && r.key === key)?.seq;

test("an upsert of a list is written and logged with a newer sequence number", async () => {
  const db = await makeDb();
  const upsert = (v: string) => db.query(
    "INSERT INTO xtream_cache (key, value, expiresAt) VALUES ('vod_streams_1', ?, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    { replacements: [v] },
  );
  await upsert("[1]");
  const first = await seqOf(db, "list", "vod_streams_1");
  await upsert("[1,2]"); // aborted with "UNIQUE constraint failed: catalog_changes" before the fix
  const [row] = (await db.query("SELECT value FROM xtream_cache WHERE key = 'vod_streams_1'", { type: QueryTypes.SELECT })) as any[];
  assert.equal(String(row.value), "[1,2]");
  assert.ok((await seqOf(db, "list", "vod_streams_1"))! > first!);
  assert.equal((await log(db)).length, 1, "one row per key");
  assert.deepEqual(await listChangesSince(db, first!), ["vod_streams_1"]);
  assert.deepEqual(await listChangesSince(db, await latestChange(db)), []);
});

test("other cache keys are not logged", async () => {
  const db = await makeDb();
  await db.query("INSERT INTO xtream_cache (key, value, expiresAt) VALUES ('series_info_9', '{}', 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  assert.deepEqual(await log(db), []);
});

test("INSERT OR IGNORE logs a new row with a new sequence number, and nothing for an ignored one", async () => {
  const db = await makeDb();
  await db.query("INSERT OR IGNORE INTO content_genres (contentId, value) VALUES ('movie_1', 'Drama')");
  const first = await seqOf(db, "tags", "movie_1");
  await db.query("INSERT OR IGNORE INTO content_genres (contentId, value) VALUES ('movie_1', 'Action')");
  const second = await seqOf(db, "tags", "movie_1");
  assert.ok(second! > first!, "the change is not lost under OR IGNORE");
  const v = await latestChange(db);
  await db.query("INSERT OR IGNORE INTO content_genres (contentId, value) VALUES ('movie_1', 'Action')"); // duplicate: ignored
  assert.equal(await latestChange(db), v);
});

test("UPDATE OR IGNORE, plain UPDATE, DELETE and a key rename are logged", async () => {
  const db = await makeDb();
  await db.query("INSERT INTO people (id, name) VALUES (1, 'A'), (2, 'B')");
  await db.query("UPDATE OR IGNORE people SET name = 'A2' WHERE id = 1");
  await db.query("UPDATE people SET id = 3 WHERE id = 2");
  await db.query("INSERT INTO content_meta (id, name) VALUES ('movie_1', 'x')");
  await db.query("DELETE FROM content_meta WHERE id = 'movie_1'");
  const keys = (await log(db)).map((r) => `${r.tbl}:${r.key}`).sort();
  assert.deepEqual(keys, ["person:1", "person:2", "person:3", "title:movie_1"]);
});

test("a NULL key never fails the write", async () => {
  const db = await makeDb();
  await db.query("INSERT INTO content_overrides (item_key, hidden) VALUES (NULL, 1)");
  assert.deepEqual(await log(db), []);
});

test("switching on again replaces the triggers; off removes the log", async () => {
  const db = await makeDb();
  await setChangeCapture(db, true);
  const triggers = (await db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'", { type: QueryTypes.SELECT })) as any[];
  assert.equal(triggers[0].n, 30, "10 tables x 3 events, once each");
  await setChangeCapture(db, false);
  const left = (await db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('trigger', 'table') AND name LIKE '%catalog%'", { type: QueryTypes.SELECT })) as any[];
  assert.equal(left[0].n, 0);
});
