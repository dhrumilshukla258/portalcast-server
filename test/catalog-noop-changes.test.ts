// Writes that change nothing served (content/catalog/changes.ts NOT_SERVED) do not move the
// catalog version; every real change still does.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { QueryTypes, Sequelize } from "sequelize";
import { setChangeCapture, latestChange } from "../src/content/catalog/changes";

async function makeDb(): Promise<Sequelize> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-noop-"));
  const db = new Sequelize({ dialect: "sqlite", storage: path.join(dir, "t.db"), logging: false });
  for (const sql of [
    "CREATE TABLE content_meta (id TEXT PRIMARY KEY, name TEXT, rating REAL, updatedAt DATETIME, detailsCheckedAt DATETIME, omdbCheckedAt DATETIME)",
    "CREATE TABLE content_genres (contentId TEXT, value TEXT)",
    "CREATE TABLE content_countries (contentId TEXT, value TEXT)",
    "CREATE TABLE content_themes (contentId TEXT, value TEXT)",
    "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, detailsCheckedAt DATETIME)",
    "CREATE TABLE title_people (titleKey TEXT, personId INTEGER)",
    "CREATE TABLE content_overrides (item_key TEXT UNIQUE, hidden INTEGER, updatedAt DATETIME)",
    "CREATE TABLE genre_overrides (genre_key TEXT UNIQUE, hidden INTEGER, updatedAt DATETIME)",
    "CREATE TABLE genres (id TEXT PRIMARY KEY, title TEXT, updatedAt DATETIME)",
    "CREATE TABLE xtream_cache (key TEXT PRIMARY KEY, value BLOB, expiresAt DATETIME)",
  ]) await db.query(sql);
  await setChangeCapture(db, true);
  return db;
}

test("a list written again unchanged (a longer expiry) is not a change; new content is", async () => {
  const db = await makeDb();
  const upsert = (v: string, exp: number) => db.query(
    "INSERT INTO xtream_cache (key, value, expiresAt) VALUES ('vod_streams_1', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expiresAt = excluded.expiresAt",
    { replacements: [v, exp] },
  );
  await upsert("[1]", 1);
  const v1 = await latestChange(db);
  assert.ok(v1 > 0, "a new list is a change");
  await upsert("[1]", 2);
  assert.equal(await latestChange(db), v1, "same value, new expiry");
  await upsert("[1,2]", 3);
  assert.ok((await latestChange(db)) > v1, "new content");
});

test("bookkeeping columns alone do not move the version; served ones do", async () => {
  const db = await makeDb();
  await db.query("INSERT INTO content_meta (id, name, rating) VALUES ('movie_1', 'A', 7)");
  const v1 = await latestChange(db);
  await db.query("UPDATE content_meta SET updatedAt = '2026-10-23', detailsCheckedAt = '2026-10-23', omdbCheckedAt = '2026-10-23' WHERE id = 'movie_1'");
  assert.equal(await latestChange(db), v1, "checked-at and updatedAt only");
  await db.query("UPDATE content_meta SET name = 'A' WHERE id = 'movie_1'");
  assert.equal(await latestChange(db), v1, "the same value written again");
  await db.query("UPDATE content_meta SET rating = 7.5, detailsCheckedAt = '2026-10-24' WHERE id = 'movie_1'");
  assert.ok((await latestChange(db)) > v1, "a served column changed");
  const v2 = await latestChange(db);
  await db.query("UPDATE content_meta SET rating = NULL WHERE id = 'movie_1'");
  assert.ok((await latestChange(db)) > v2, "a value cleared (NULL) is a change");
});

test("a person's detailsCheckedAt is served (the snapshot holds it): it counts", async () => {
  const db = await makeDb();
  await db.query("INSERT INTO people (id, name) VALUES (1, 'Ann')");
  const v1 = await latestChange(db);
  await db.query("UPDATE people SET detailsCheckedAt = '2026-10-23' WHERE id = 1");
  assert.ok((await latestChange(db)) > v1);
});

test("inserts and deletes always count", async () => {
  const db = await makeDb();
  await db.query("INSERT INTO genres (id, title) VALUES ('g1', 'Drama')");
  const v1 = await latestChange(db);
  await db.query("DELETE FROM genres WHERE id = 'g1'");
  assert.ok((await latestChange(db)) > v1);
  const rows = (await db.query("SELECT tbl, key FROM catalog_changes", { type: QueryTypes.SELECT })) as any[];
  assert.deepEqual(rows, [{ tbl: "genres", key: "g1" }]);
});
