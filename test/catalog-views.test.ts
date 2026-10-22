import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import sqlite3 from "sqlite3";
import { buildSnapshot } from "../src/content/catalog/builder";
import { CatalogSnapshot } from "../src/content/catalog/snapshot";
import { AllView } from "../src/content/catalog/views";
import { SearchIndex } from "../src/content/searchIndex";

// The "All" view's search must rank exactly as SearchIndex over the same visible list (what
// catalogUnion + filterBySearch answered), including hidden categories and lists read from the
// cache because they changed after the snapshot was built.

const cat1 = [
  { name: "Spider-Man", stream_id: 1, year: "2002" },
  { name: "Spider Man 2", stream_id: 2, year: "2004" },
  { name: "The Dark Knight", stream_id: 3, year: "2008" },
  { name: "Batmen Returns", stream_id: 4, year: "1992" },
  { name: "Amélie", stream_id: 5, year: "2001" },
  { name: "Fast & Furious", stream_id: 6, year: "2009" },
  { name: "Love Actually", stream_id: 7, year: "2003" },
  { name: "Love", stream_id: 8, year: "2015" },
];
const cat2 = [ // hidden in some views
  { name: "Batman Begins", stream_id: 20, year: "2005" },
  { name: "Love", stream_id: 8, year: "2015" }, // same title in two categories
  { name: "Lovely Bones", stream_id: 21, year: "2009" },
];
const cat3 = [
  { name: "The Godfather", stream_id: 30, year: "1972" },
  { name: "Godfather Part II", stream_id: 31, year: "1974" },
  { name: "A Love Story", stream_id: 32, year: "1970" },
  { name: "Of Mice and Men", stream_id: 33, year: "1992" },
];
const cat3Changed = [{ name: "The Godfather Returns", stream_id: 34, year: "2026" }, ...cat3.slice(1)];

const QUERIES = [
  "spiderman", "spider man", "spider", "man spider", "dark knight", "knight dark", "batman", "batmen", "batma", "batmn",
  "amelie", "fast and furious", "fast & furious", "love", "love 2015", "lov", "the", "a", "of", "godfather", "godfathr",
  "god", "2009", "the godfather 1972", "zzz", "!!!", "", "knigth", "returns", "mice men",
];

const exec = (db: sqlite3.Database, sql: string, params: any[] = []) =>
  new Promise<void>((resolve, reject) => db.run(sql, params, (e) => (e ? reject(e) : resolve())));

let snap: CatalogSnapshot | null = null;
async function snapshot(): Promise<CatalogSnapshot> {
  if (snap) return snap;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-views-"));
  const file = path.join(dir, "t.db");
  const db = new sqlite3.Database(file);
  await exec(db, "CREATE TABLE content_meta (id TEXT PRIMARY KEY, type TEXT)");
  for (const t of ["content_genres", "content_countries", "content_themes"]) await exec(db, `CREATE TABLE ${t} (contentId TEXT, value TEXT)`);
  await exec(db, "CREATE TABLE people (id INTEGER PRIMARY KEY, tmdbPersonId INTEGER, name TEXT, photo TEXT, biography TEXT, knownFor TEXT, birthday TEXT, deathday TEXT, placeOfBirth TEXT, detailsCheckedAt TEXT)");
  await exec(db, "CREATE TABLE title_people (titleKey TEXT, personId INTEGER, kind TEXT, role TEXT, sortOrder INTEGER)");
  await exec(db, "CREATE TABLE xtream_cache (key TEXT PRIMARY KEY, value BLOB)");
  for (const [id, list] of [["1", cat1], ["2", cat2], ["3", cat3]] as const) await exec(db, "INSERT INTO xtream_cache VALUES (?, ?)", [`vod_streams_${id}`, JSON.stringify(list)]);
  await new Promise<void>((resolve) => db.close(() => resolve()));
  const out = await buildSnapshot({
    dbPath: file, genres: { movie: ["1", "2", "3"], series: [] }, chunkBits: 10,
    copyColumns: [{ name: "id", kind: "text" }, { name: "type", kind: "text" }],
  });
  return (snap = new CatalogSnapshot(out.version, "now", out.counts, out.sections));
}

const catIndex = (s: CatalogSnapshot, id: string) => { for (let c = 0; c < s.listCategoryCount; c++) if (s.listCategory(c).id === id) return c; return -1; };

async function viewOf(parts: { cat: string; list?: any[] }[]) {
  const s = await snapshot();
  return new AllView("test", "movie", s, parts.map((p) => ({ cat: p.cat, c: catIndex(s, p.cat), list: p.list ?? null, fromSnapshot: !p.list })));
}

function assertSameRanking(view: AllView, items: any[]) {
  const index = new SearchIndex(items);
  for (const q of QUERIES) {
    // SearchIndex returns the very objects of `items`: their positions are what the view returns.
    const want = (q.trim() ? index.search(q) : items).map((it) => items.findIndex((x) => x === it));
    assert.deepEqual(view.searchPositions(q), want, `query ${JSON.stringify(q)}`);
  }
}

test("search ranks exactly as SearchIndex over every category", async () => {
  const view = await viewOf([{ cat: "1" }, { cat: "2" }, { cat: "3" }]);
  assertSameRanking(view, [...cat1, ...cat2, ...cat3]);
});

test("a hidden category takes no part, not even in the typo fallback", async () => {
  // "batman" exists only in the hidden category: SearchIndex over the visible titles has no
  // such term and falls back to one edit away ("batmen"); the view must do the same.
  const view = await viewOf([{ cat: "1" }, { cat: "3" }]);
  assertSameRanking(view, [...cat1, ...cat3]);
  assert.deepEqual(view.searchPositions("batman"), [3]);
});

test("a list that changed after the snapshot is searched and listed from the cache", async () => {
  const view = await viewOf([{ cat: "1" }, { cat: "2" }, { cat: "3", list: cat3Changed }]);
  assertSameRanking(view, [...cat1, ...cat2, ...cat3Changed]);
  assert.equal(view.length, cat1.length + cat2.length + cat3Changed.length);
  assert.equal(view.categoryOf(34), "3");
  assert.equal(view.categoryOf(30), undefined, "gone from the changed list");
  assert.deepEqual(view.item(34), cat3Changed[0]);
});

test("an item in two categories belongs to the first; unknown ids are absent", async () => {
  const view = await viewOf([{ cat: "1" }, { cat: "2" }, { cat: "3" }]);
  assert.equal(view.categoryOf(8), "1");
  assert.equal(view.categoryOf("21"), "2");
  assert.deepEqual(view.item(8), cat1[7]);
  assert.equal(view.categoryOf(999), undefined);
  assert.equal(view.item(999), null);
  const hidden1 = await viewOf([{ cat: "2" }, { cat: "3" }]);
  assert.equal(hidden1.categoryOf(8), "2");
});
