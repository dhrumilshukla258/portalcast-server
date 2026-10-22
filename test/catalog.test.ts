import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import sqlite3 from "sqlite3";
import { buildSnapshot, type ColumnSpec } from "../src/content/catalog/builder";
import { CatalogSnapshot } from "../src/content/catalog/snapshot";
import { readSnapshotFile, writeSnapshotFile } from "../src/content/catalog/format";

// A small database with the edge cases, built with 128-byte chunks so texts cross chunk ends.
const COLUMNS: ColumnSpec[] = [
  ...["id", "type", "name", "overview"].map((name) => ({ name, kind: "text" as const })),
  { name: "enrichedAt", kind: "date" },
  ...["tmdbId", "rating", "runtime"].map((name) => ({ name, kind: "num" as const })),
];

const BOM_PLOT = "﻿Starts with a byte order mark.";
const EXACT_CHUNK = "x".repeat(128); // exactly one chunk
const copies: [string, string, string, string | null, string | null, number | null, number | null, number | null][] = [
  ["movie_1", "movie", "Zeta", "A plot that is long enough to cross the end of a 64-byte chunk for sure.", "2026-10-20 12:34:56.789 +00:00", 603, 7.25, 136],
  ["movie_2", "movie", "Alpha", "", null, 3_000_000_000, null, null],
  ["series_7", "series", "Ünïcödé 🎬", BOM_PLOT, "2026-01-02 03:04:05.000 +00:00", 1399, 8, 55],
  ["movie_3", "movie", "Zeta", EXACT_CHUNK, null, 603, 7.25, 136],
  ["movie_4", "movie", "Dup", "A plot that is long enough to cross the end of a 64-byte chunk for sure.", null, null, null, null],
];

const exec = (db: sqlite3.Database, sql: string, params: any[] = []) =>
  new Promise<void>((resolve, reject) => db.run(sql, params, (e) => (e ? reject(e) : resolve())));

async function makeDb(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-catalog-"));
  const file = path.join(dir, "test.db");
  const db = new sqlite3.Database(file);
  await exec(db, "CREATE TABLE content_meta (id TEXT PRIMARY KEY, type TEXT, name TEXT, overview TEXT, enrichedAt DATETIME, tmdbId INTEGER, rating FLOAT, runtime INTEGER)");
  for (const c of copies) await exec(db, "INSERT INTO content_meta VALUES (?,?,?,?,?,?,?,?)", c);
  for (const t of ["content_genres", "content_countries", "content_themes"]) await exec(db, `CREATE TABLE ${t} (contentId TEXT, value TEXT)`);
  for (const [c, v] of [["movie_1", "Drama"], ["movie_1", "Action"], ["series_7", "Drama"], ["gone_9", "Drama"], ["movie_3", "Comedy"]]) {
    await exec(db, "INSERT INTO content_genres VALUES (?, ?)", [c, v]);
  }
  await exec(db, "CREATE TABLE people (id INTEGER PRIMARY KEY, tmdbPersonId INTEGER, name TEXT, photo TEXT, biography TEXT, knownFor TEXT, birthday TEXT, deathday TEXT, placeOfBirth TEXT, detailsCheckedAt TEXT)");
  await exec(db, "INSERT INTO people (id, tmdbPersonId, name) VALUES (1, 6384, 'Keanu Reeves')");
  await exec(db, "INSERT INTO people (id, tmdbPersonId, name, photo, birthday, biography) VALUES (2, NULL, 'Carrie-Anne Moss', '/p.jpg', '1967-08-21', ?)", ["A biography that is longer than one chunk of sixty-four bytes, to cross."]);
  await exec(db, "INSERT INTO people (id, tmdbPersonId, name) VALUES (5, 9999, 'No credits')");
  await exec(db, "CREATE TABLE title_people (titleKey TEXT, personId INTEGER, kind TEXT, role TEXT, sortOrder INTEGER)");
  for (const r of [["movie:603", 2, "cast", "Trinity", 1], ["movie:603", 1, "cast", "Neo", 0], ["movie:603", 1, "director", null, 5], ["movie:603", 77, "cast", "Orphan", 2], ["series_7", 2, "creator", null, 0]]) {
    await exec(db, "INSERT INTO title_people VALUES (?,?,?,?,?)", r);
  }
  await exec(db, "CREATE TABLE xtream_cache (key TEXT PRIMARY KEY, value BLOB)");
  const movies = [
    { num: 1, name: "Zeta", stream_id: 1, rating: "7.2", nested: { a: [1, 2] } },
    { num: 2, name: "Alpha", stream_id: 2, extra: null },
    null,
    [1, "two"],
    { num: 3, name: "Not in meta", stream_id: 42 },
  ];
  await exec(db, "INSERT INTO xtream_cache VALUES ('vod_streams_10', ?)", [JSON.stringify(movies)]);
  await exec(db, "INSERT INTO xtream_cache VALUES ('series_list_20', ?)", [zlib.deflateSync(Buffer.from(JSON.stringify([{ name: "Ünïcödé 🎬", series_id: 7 }])))]);
  await exec(db, "CREATE TABLE catalog_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT, key TEXT)");
  await exec(db, "INSERT INTO catalog_changes (tbl, key) VALUES ('title', 'movie_1'), ('list', 'vod_streams_*')");
  await new Promise<void>((resolve) => db.close(() => resolve()));
  return file;
}

let built: { snap: CatalogSnapshot; out: Awaited<ReturnType<typeof buildSnapshot>>; dbFile: string } | null = null;
async function snapshot() {
  if (built) return built;
  const dbFile = await makeDb();
  const out = await buildSnapshot({ dbPath: dbFile, copyColumns: COLUMNS, genres: { movie: ["10", "11"], series: ["20"] }, chunkBits: 7 });
  built = { snap: new CatalogSnapshot(out.version, "now", out.counts, out.sections), out, dbFile };
  return built;
}

test("every copy column reads back as stored, across chunk ends", async () => {
  const { snap, out } = await snapshot();
  assert.equal(out.version, 2);
  assert.ok(Object.keys(out.sections).filter((k) => k.startsWith("pool.chunk.")).length > 3, "texts span several chunks");
  for (const [id, type, name, overview, enrichedAt, tmdbId, rating, runtime] of copies) {
    const i = snap.copyIndex(id);
    assert.ok(i >= 0, id);
    assert.equal(snap.copyText("type", i), type);
    assert.equal(snap.copyText("name", i), name);
    assert.equal(snap.copyText("overview", i), overview, `${id} overview`);
    assert.equal(snap.copyNum("enrichedAt", i), enrichedAt === null ? null : Date.parse(enrichedAt.replace(" ", "T").replace(" +00:00", "Z")));
    assert.equal(snap.copyNum("tmdbId", i), tmdbId);
    assert.equal(snap.copyNum("rating", i), rating);
    assert.equal(snap.copyNum("runtime", i), runtime);
  }
  assert.equal(snap.copyIndex("movie_404"), -1);
  assert.equal(snap.copyText("overview", snap.copyIndex("movie_2")), "", "empty text is not NULL");
  assert.equal(snap.copyText("overview", snap.copyIndex("series_7"))!.charCodeAt(0), 0xfeff, "a leading BOM is kept");
});

test("texts are stored once; number columns narrow only when every value fits", async () => {
  const { out } = await snapshot();
  // Distinct texts: 5 ids + 2 types + 4 names + 4 plots ("" included) + tags, people, roles, keys, list values...
  // The duplicate plot and the duplicate name "Zeta" must not add a second copy.
  const pool = Object.keys(out.sections).filter((k) => k.startsWith("pool.chunk.")).reduce((n, k) => n + out.sections[k].byteLength, 0);
  const starts = out.sections["pool.start"] as Uint32Array;
  assert.equal(starts.length, out.counts.strings + 2, "one start per text, plus id 0 and the end sentinel");
  assert.ok(pool < 2000, `pool ${pool} bytes`);
  const overview = out.sections["copy.overview"] as Uint32Array, ids = out.sections["copy.id"] as Uint32Array;
  const at = (id: string) => [...ids].findIndex((_, i) => built!.snap.copyText("id", i) === id);
  assert.equal(overview[at("movie_1")], overview[at("movie_4")], "the same plot on two copies is one pooled text");
  assert.equal(out.sections["copy.runtime"].constructor.name, "Int32Array");
  assert.equal(out.sections["copy.rating"].constructor.name, "Float64Array", "7.25 is not a whole number");
  assert.equal(out.sections["copy.tmdbId"].constructor.name, "Float64Array", "3e9 does not fit in int32");
  assert.equal(out.sections["credit.order"].constructor.name, "Int16Array");
});

test("tags keep stored order, skip orphans, and index both ways", async () => {
  const { snap } = await snapshot();
  assert.deepEqual(snap.tagsOf("genre", snap.copyIndex("movie_1")), ["Drama", "Action"]);
  assert.deepEqual(snap.tagsOf("genre", snap.copyIndex("movie_2")), []);
  assert.deepEqual([...snap.copiesWithTag("genre", "Drama")].map((i) => snap.copyText("id", i)).sort(), ["movie_1", "series_7"]);
  assert.equal(snap.copiesWithTag("genre", "Western").length, 0);
  assert.deepEqual(snap.copiesByTmdb("movie", 603).map((i) => snap.copyText("id", i)).sort(), ["movie_1", "movie_3"]);
  assert.deepEqual(snap.copiesByTmdb("series", 603), []);
});

test("credits come in billing order; people details are sparse but complete", async () => {
  const { snap, out } = await snapshot();
  const credits = snap.creditsOf("movie:603").map((c) => [snap.person(c.person).name, c.kind, c.role, c.order]);
  assert.deepEqual(credits, [["Keanu Reeves", "cast", "Neo", 0], ["Carrie-Anne Moss", "cast", "Trinity", 1], ["Keanu Reeves", "director", null, 5]]);
  assert.deepEqual(snap.creditsOf("movie:1"), []);
  assert.equal(out.counts.peopleWithDetails, 1);
  const moss = snap.person(snap.personIndex(2));
  assert.deepEqual(moss, {
    id: 2, tmdbPersonId: null, name: "Carrie-Anne Moss", photo: "/p.jpg", knownFor: null, birthday: "1967-08-21", deathday: null,
    placeOfBirth: null, detailsCheckedAt: null, biography: "A biography that is longer than one chunk of sixty-four bytes, to cross.",
  });
  assert.equal(snap.person(snap.personIndex(1)).birthday, null);
  assert.equal(snap.person(snap.personIndex(5)).tmdbPersonId, 9999);
  assert.equal(snap.personIndex(3), -1);
  assert.deepEqual(snap.personCredits(snap.personIndex(2)).map((c) => [c.titleKey, c.kind]).sort(), [["movie:603", "cast"], ["series_7", "creator"]]);
  assert.deepEqual(snap.personCredits(snap.personIndex(5)), []);
});

test("list entries rebuild exactly, whatever their shape", async () => {
  const { snap } = await snapshot();
  const movies = snap.categories("movie");
  assert.deepEqual(movies.map((c) => [c.id, c.end - c.start]), [["10", 5], ["11", 0]]);
  const got = [];
  for (let k = movies[0].start; k < movies[0].end; k++) got.push(snap.listItem(k));
  assert.deepEqual(got, [
    { num: 1, name: "Zeta", stream_id: 1, rating: "7.2", nested: { a: [1, 2] } },
    { num: 2, name: "Alpha", stream_id: 2, extra: null },
    null,
    [1, "two"],
    { num: 3, name: "Not in meta", stream_id: 42 },
  ]);
  assert.equal(JSON.stringify(snap.listItem(movies[0].start)), '{"num":1,"name":"Zeta","stream_id":1,"rating":"7.2","nested":{"a":[1,2]}}', "key order kept");
  assert.equal(snap.listField(movies[0].start, "rating"), "7.2");
  assert.deepEqual(snap.listField(movies[0].start, "nested"), { a: [1, 2] });
  assert.equal(snap.listField(movies[0].start + 1, "extra"), null);
  assert.equal(snap.listField(movies[0].start + 1, "rating"), undefined);
  assert.equal(snap.listField(movies[0].start + 2, "name"), undefined);
  assert.deepEqual([0, 1, 4].map((j) => snap.listItemCopy(movies[0].start + j)), [snap.copyIndex("movie_1"), snap.copyIndex("movie_2"), -1]);
  const series = snap.categories("series");
  assert.deepEqual(snap.listItem(series[0].start), { name: "Ünïcödé 🎬", series_id: 7 }, "compressed cache value");
  assert.equal(snap.listItemCopy(series[0].start), snap.copyIndex("series_7"));
});

test("the file round-trips byte for byte and a damaged file is refused", async () => {
  const { out } = await snapshot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-catalog-file-"));
  const file = await writeSnapshotFile(dir, { version: out.version, builtAt: "now", checksum: out.checksum, counts: out.counts }, out.sections);
  const back = await readSnapshotFile(file);
  assert.deepEqual(Object.keys(back.sections).sort(), Object.keys(out.sections).sort());
  for (const [name, v] of Object.entries(out.sections)) {
    const w = back.sections[name];
    assert.equal(w.constructor, v.constructor, name);
    assert.ok(Buffer.from(w.buffer, w.byteOffset, w.byteLength).equals(Buffer.from(v.buffer, v.byteOffset, v.byteLength)), name);
  }
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 3] ^= 0xff;
  fs.writeFileSync(file, bytes);
  await assert.rejects(readSnapshotFile(file), /checksum mismatch/);
});

test("a text longer than a chunk fails the build instead of being cut", async () => {
  const { dbFile } = await snapshot();
  await assert.rejects(
    buildSnapshot({ dbPath: dbFile, copyColumns: COLUMNS, genres: { movie: [], series: [] }, chunkBits: 6 }),
    /longer than a snapshot chunk/,
  );
});
