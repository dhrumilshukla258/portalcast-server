// IMDb titles for matching (owner, 2026-10-23: "if the user downloads the IMDb dataset, we use
// the IMDb method first"). Optional: setting imdbMatching, off by default. IMDb's free files
// (datasets.imdbws.com, personal and non-commercial use) are downloaded by each server itself.
//
// Build (job "imdb-titles", weekly while on): a worker thread streams title.ratings,
// title.basics and title.akas from IMDb through gunzip into a separate SQLite file next to the
// database (imdb.db: titles and every name each title is known by, normalized), then swaps it in.
// Nothing is kept: type and votes per title sit in two typed arrays (~135 MB) during the build.
// Movies and series only (no episodes, shorts or adult titles), with at least one vote or from
// the last two years.
//
// Match (content/metaEnrichment.ts resolveMeta, before the TMDB search): a known title at the
// START of a portal name (or after a "Channel :" prefix), longest first, of the same type and
// year (within 1; a series' run), where what is left is only tags (this portal's word lists,
// titleClean.ts), a year or a season marker. Measured on a 133k catalog: about 98% right where
// it matches, against about 94% for the TMDB search on the same titles.

import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { dataDir } from "@/infra/paths";
import { logger } from "@/infra/logger";
import { stripReleaseNoise } from "@/content/titleClean";
import { setting } from "@/config/settings";
import { findTmdbIdByImdb, fetchMetaByTmdbId, type TmdbMeta } from "@/content/tmdb";

export const IMDB_FILES = {
  ratings: "https://datasets.imdbws.com/title.ratings.tsv.gz",
  basics: "https://datasets.imdbws.com/title.basics.tsv.gz",
  akas: "https://datasets.imdbws.com/title.akas.tsv.gz",
};
const DB_FILE = () => path.join(dataDir, "imdb.db");

/** A title name as a lookup key: no accents, case, apostrophes or punctuation; "&" is "and". */
export function imdbKey(s: string): string {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

// ── Build (worker) ────────────────────────────────────────────────────────────────
// Runs from source text (eval), like content/peopleSearch.ts: no separate build entry.
function workerMain(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { parentPort, workerData } = require("worker_threads");
  const fs = require("fs");
  const zlib = require("zlib");
  const https = require("https");
  const readline = require("readline");
  const sqlite3 = require(workerData.sqlite3);
  const key = new Function(`return (${workerData.keySource})`)() as (s: string) => string;
  const MOVIE = new Set(["movie", "tvMovie", "video", "tvSpecial"]);
  const SERIES = new Set(["tvSeries", "tvMiniSeries"]);
  const thisYear = new Date().getFullYear();

  const get = (url: string, hops = 0): Promise<any> => new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "PortalCast" } }, (res: any) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 3) { res.resume(); resolve(get(res.headers.location, hops + 1)); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      resolve(res);
    }).on("error", reject);
  });
  const open = async (src: string) => (/^https:/.test(src) ? await get(src) : fs.createReadStream(src));
  async function* lines(src: string) {
    const rl = readline.createInterface({ input: (await open(src)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    let first = true;
    for await (const l of rl) { if (first) { first = false; continue; } yield l as string; }
  }

  (async () => {
    const started = Date.now();
    try { fs.unlinkSync(workerData.tmp); } catch { /* none */ }
    const db = new sqlite3.Database(workerData.tmp);
    const run = (sql: string, p: unknown[] = []) => new Promise<void>((res, rej) => db.run(sql, p, (e: any) => (e ? rej(e) : res())));
    const exec = (sql: string) => new Promise<void>((res, rej) => db.exec(sql, (e: any) => (e ? rej(e) : res())));
    try {
      await exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE;"
        + "CREATE TABLE titles (id INTEGER PRIMARY KEY, kind INTEGER NOT NULL, year INTEGER NOT NULL, endYear INTEGER NOT NULL, votes INTEGER NOT NULL);"
        + "CREATE TABLE names_raw (key TEXT NOT NULL, id INTEGER NOT NULL, own INTEGER NOT NULL);"
        + "CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);");
      // Rows go in many at a time (one statement per batch), inside transactions.
      const batch = (table: string, cols: number, size: number) => {
        const one = `(${Array(cols).fill("?").join(",")})`;
        const full = `INSERT INTO ${table} VALUES ${Array(size).fill(one).join(",")}`;
        let buf: unknown[] = [], n = 0;
        return {
          async add(...v: unknown[]) { buf.push(...v); if (++n === size) { await run(full, buf); buf = []; n = 0; } },
          async flush() { if (n) await run(`INSERT INTO ${table} VALUES ${Array(n).fill(one).join(",")}`, buf); buf = []; n = 0; },
        };
      };
      const votes = new Uint16Array(50_000_000);
      const kind = new Uint8Array(50_000_000);
      for await (const l of lines(workerData.files.ratings)) {
        const a = l.indexOf("\t"), b = l.lastIndexOf("\t");
        const n = +l.slice(2, a);
        if (n < votes.length) votes[n] = Math.min(65535, +l.slice(b + 1));
      }
      parentPort.postMessage({ progress: "ratings read" });

      await run("BEGIN");
      const titles = batch("titles", 5, 150), names = batch("names_raw", 3, 250);
      let kept = 0, rows = 0;
      for await (const l of lines(workerData.files.basics)) {
        const c = l.split("\t");
        const k = MOVIE.has(c[1]) ? 1 : SERIES.has(c[1]) ? 2 : 0;
        if (!k || c[4] === "1") continue;
        const n = +c[0].slice(2);
        const year = c[5] === "\\N" ? 0 : +c[5];
        if (n >= kind.length || (!votes[n] && year < thisYear - 1)) continue;
        kind[n] = k; kept++;
        await titles.add(n, k, year, c[6] === "\\N" ? 0 : +c[6], votes[n]);
        for (const t of new Set([key(c[2]), key(c[3])])) {
          if (!t) continue;
          await names.add(t, n, 1); rows++;
          if (t.startsWith("the ")) { await names.add(t.slice(4), n, 1); rows++; }
        }
        if (kept % 50_000 === 0) { await titles.flush(); await names.flush(); await run("COMMIT"); await run("BEGIN"); }
      }
      await titles.flush(); await names.flush(); await run("COMMIT");
      parentPort.postMessage({ progress: `titles read: ${kept}` });

      await run("BEGIN");
      let akas = 0;
      for await (const l of lines(workerData.files.akas)) {
        const a = l.indexOf("\t");
        const n = +l.slice(2, a);
        if (n >= kind.length || !kind[n]) continue;
        const b = l.indexOf("\t", a + 1), e = l.indexOf("\t", b + 1);
        const t = key(l.slice(b + 1, e));
        if (!t) continue;
        await names.add(t, n, 0); rows++; akas++;
        if (t.startsWith("the ")) { await names.add(t.slice(4), n, 0); rows++; }
        if (akas % 200_000 === 0) { await names.flush(); await run("COMMIT"); await run("BEGIN"); }
      }
      await names.flush(); await run("COMMIT");
      parentPort.postMessage({ progress: `alternative names read: ${akas}` });

      // One row per (name, title), "own" if any spelling was the title's own; then the index.
      await exec("CREATE TABLE names (key TEXT NOT NULL, id INTEGER NOT NULL, own INTEGER NOT NULL);"
        + "INSERT INTO names SELECT key, id, MAX(own) FROM names_raw GROUP BY key, id;"
        + "DROP TABLE names_raw; CREATE INDEX names_key ON names (key); VACUUM;");
      const [count] = await new Promise<any[]>((res, rej) => db.all("SELECT (SELECT COUNT(*) FROM titles) t, (SELECT COUNT(*) FROM names) n", (e: any, r: any) => (e ? rej(e) : res(r))));
      await run("INSERT INTO meta VALUES ('builtAt', ?), ('titles', ?), ('names', ?)", [String(Date.now()), String(count.t), String(count.n)]);
      await new Promise<void>((res) => db.close(() => res()));
      parentPort.postMessage({ done: true, titles: count.t, names: count.n, ms: Date.now() - started });
    } catch (e: any) {
      await new Promise<void>((res) => db.close(() => res()));
      parentPort.postMessage({ error: String(e?.message ?? e) });
    }
  })();
}

let building: Promise<string> | null = null;

/**
 * Downloads IMDb's files and builds imdb.db (job "imdb-titles"). [files]: other sources (local
 * paths for tests and measurements). Returns a one-line summary.
 */
export function buildImdbIndex(files: typeof IMDB_FILES = IMDB_FILES): Promise<string> {
  if (building) return building;
  building = new Promise<string>((resolve, reject) => {
    const tmp = DB_FILE() + ".building";
    const source = `var __name = (f) => f;\n(${workerMain.toString()})();`;
    const worker = new Worker(source, {
      eval: true,
      resourceLimits: { maxYoungGenerationSizeMb: 8 },
      workerData: { files, tmp, sqlite3: require.resolve("sqlite3"), keySource: imdbKey.toString() },
    });
    let done = false;
    worker.on("message", async (m: any) => {
      if (m.progress) { logger.info(`[imdb] ${m.progress}`); return; }
      done = true;
      if (m.error) { reject(new Error(m.error)); return; }
      try {
        await closeReader();
        fs.renameSync(tmp, DB_FILE());
        resolve(`${m.titles} titles, ${m.names} names indexed in ${Math.round(m.ms / 60000)} min`);
      } catch (e) { reject(e); }
    });
    worker.once("error", (e) => { if (!done) { done = true; reject(e); } });
    worker.once("exit", (code) => { if (!done) { done = true; reject(new Error(`worker exited (${code})`)); } });
  }).finally(() => { building = null; });
  return building;
}

// ── Reader ────────────────────────────────────────────────────────────────────────

let reader: any = null;
async function openReader(): Promise<any | null> {
  if (reader) return reader;
  if (!fs.existsSync(DB_FILE())) return null;
  const sqlite3 = (await import("sqlite3")).default;
  reader = await new Promise((res, rej) => { const d = new sqlite3.Database(DB_FILE(), sqlite3.OPEN_READONLY, (e) => (e ? rej(e) : res(d))); });
  return reader;
}
async function closeReader(): Promise<void> {
  if (!reader) return;
  const r = reader; reader = null;
  await new Promise<void>((res) => r.close(() => res()));
}
const all = async (sql: string, p: unknown[]): Promise<any[]> => {
  const d = await openReader();
  if (!d) return [];
  return new Promise((res, rej) => d.all(sql, p, (e: any, r: any[]) => (e ? rej(e) : res(r))));
};

/** Whether an index is there (built at least once). */
export function imdbIndexReady(): boolean {
  return fs.existsSync(DB_FILE());
}

// ── Match ─────────────────────────────────────────────────────────────────────────

export interface ImdbMatch { imdbId: string; kind: "movie" | "series"; year: number; votes: number; ownName: boolean; leftover: string }

// Words of a raw name with where each ends, so what follows a matched title can be read back
// from the raw text ("&" is a word: it keys as "and").
const WORD = /&|[\p{L}\p{N}]+(?:['’`][\p{L}\p{N}]+)*/gu;
const YEAR = /^(19\d{2}|20[0-3]\d)$/;
const MARK_WORDS = new Set(["season", "seasons", "part", "vol", "volume", "chapter", "episode", "series"]);

/** What is left after a title is only tags (this portal's lists), years or season markers. */
export function onlyTagsLeft(leftover: string): boolean {
  const rest = imdbKey(stripReleaseNoise(leftover)).split(" ").filter(Boolean);
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (YEAR.test(w) || /^s\d{1,2}(e\d{1,3})?$/.test(w) || /^e\d{1,3}$/.test(w) || w === "to" || w === "current" || w === "complete") continue;
    if (MARK_WORDS.has(w) && /^\d{1,3}$/.test(rest[i + 1] ?? "")) { i++; continue; }
    if (/^(i{1,3}|iv|v|vi{0,3}|ix|x)$/.test(w) && MARK_WORDS.has(rest[i - 1] ?? "")) continue;
    return false;
  }
  return true;
}

/**
 * The IMDb title at the start of a portal name, or null. [kind] the portal's type, [year] the
 * portal's year (0 unknown).
 */
export async function matchImdb(name: string, kind: "movie" | "series", year: number): Promise<ImdbMatch | null> {
  if (!imdbIndexReady()) return null;
  const parts = [String(name || "")];
  const m = /^[^:|]{2,40}[:|]\s*(.+)$/.exec(parts[0]);
  if (m) parts.push(m[1]);
  const k = kind === "movie" ? 1 : 2;
  for (const part of parts) {
    const words = [...part.matchAll(WORD)].map((w) => ({ key: imdbKey(w[0]), end: w.index! + w[0].length })).filter((w) => w.key);
    if (!words.length) continue;
    const prefixes: string[] = [];
    for (let n = words.length; n >= 1; n--) prefixes.push(words.slice(0, n).map((w) => w.key).join(" "));
    const rows = await all(
      `SELECT n.key, n.id, n.own, t.kind, t.year, t.endYear, t.votes FROM names n JOIN titles t ON t.id = n.id WHERE n.key IN (${prefixes.map(() => "?").join(",")}) AND t.kind = ?`,
      [...prefixes, k],
    );
    if (!rows.length) continue;
    const byKey = new Map<string, any[]>();
    for (const r of rows) { let a = byKey.get(r.key); if (!a) byKey.set(r.key, (a = [])); a.push(r); }
    for (let i = 0; i < prefixes.length; i++) {
      const cands = byKey.get(prefixes[i]);
      if (!cands) continue;
      const leftover = part.slice(words[prefixes.length - 1 - i].end);
      if (!onlyTagsLeft(leftover)) continue;
      let best: any = null, bestScore = -Infinity;
      for (const c of cands) {
        const yearOk = !year || !c.year || Math.abs(c.year - year) <= 1 || (k === 2 && year >= c.year && (!c.endYear || year <= c.endYear + 1));
        if (!yearOk) continue;
        if (!c.votes && !(year && c.year === year)) continue; // an unknown title only with the same year
        const score = (c.own ? 3 : 1) + (year && c.year === year ? 2 : year && c.year ? 1 : 0) + Math.log10(c.votes + 1) * 0.5;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (best) return { imdbId: `tt${String(best.id).padStart(7, "0")}`, kind, year: best.year, votes: best.votes, ownName: !!best.own, leftover: leftover.trim() };
    }
  }
  return null;
}

/** When the index was built (ms), or 0. */
export async function imdbBuiltAt(): Promise<number> {
  const [r] = await all("SELECT v FROM meta WHERE k = 'builtAt'", []).catch(() => []);
  return Number(r?.v) || 0;
}

/** On, and an index to match against. */
export function imdbMatchingOn(): boolean {
  return !!setting<boolean>("imdbMatching") && imdbIndexReady();
}

const stats = { tried: 0, matched: 0, used: 0 };
/** Counts since start: names tried, matched on IMDb, and matches TMDB knew (used). */
export function imdbStats(): Readonly<typeof stats> {
  return stats;
}

/**
 * A title's TMDB details found through IMDb (content/metaEnrichment.ts resolveMeta, before the
 * TMDB search): the IMDb title at the start of the name, then TMDB's title for that IMDb id.
 * Null when matching is off, nothing matched, or TMDB does not know the IMDb title: the caller
 * then searches TMDB as before. [tmdb] can be replaced in tests.
 */
export async function tmdbMetaViaImdb(
  kind: "movie" | "tv",
  name: string,
  year: string,
  tmdb: { find: typeof findTmdbIdByImdb; details: typeof fetchMetaByTmdbId } = { find: findTmdbIdByImdb, details: fetchMetaByTmdbId },
): Promise<TmdbMeta | null> {
  if (!imdbMatchingOn()) return null;
  stats.tried++;
  const m = await matchImdb(name, kind === "movie" ? "movie" : "series", parseInt(year, 10) || 0).catch(() => null);
  if (!m) return null;
  stats.matched++;
  const tmdbId = await tmdb.find(m.imdbId, kind).catch(() => null);
  if (!tmdbId) return null;
  const meta = await tmdb.details(kind, tmdbId).catch(() => null);
  if (!meta) return null;
  stats.used++;
  return meta.imdbId ? meta : { ...meta, imdbId: m.imdbId };
}
