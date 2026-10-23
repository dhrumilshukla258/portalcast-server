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
  // Directors and cast, as evidence when the portal sends them (credits table).
  crew: "https://datasets.imdbws.com/title.crew.tsv.gz",
  principals: "https://datasets.imdbws.com/title.principals.tsv.gz",
  names: "https://datasets.imdbws.com/name.basics.tsv.gz",
};
const DB_FILE = () => path.join(dataDir, "imdb.db");

/** A title name as a lookup key: no accents, case, apostrophes or punctuation; "&" is "and". */
export function imdbKey(s: string): string {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** A person as a 32-bit number: their normalized name, hashed (FNV-1a). Names are compared, not kept. */
export function personHash(name: string): number {
  const s = String(name || "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/['’`.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return s ? h | 0 : 0;
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
  const person = new Function(`return (${workerData.personSource})`)() as (s: string) => number;
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
        + "CREATE TABLE titles (id INTEGER PRIMARY KEY, kind INTEGER NOT NULL, year INTEGER NOT NULL, endYear INTEGER NOT NULL, votes INTEGER NOT NULL, rating INTEGER NOT NULL);"
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
      const votes = new Uint16Array(50_000_000); // exact up to 32767, then in thousands (to ~32 million)
      const kind = new Uint8Array(50_000_000);
      const rating = new Uint8Array(50_000_000); // average rating x 10
      for await (const l of lines(workerData.files.ratings)) {
        const a = l.indexOf("\t"), b = l.lastIndexOf("\t");
        const n = +l.slice(2, a);
        if (n < votes.length) { const v = +l.slice(b + 1); votes[n] = v < 32768 ? v : Math.min(65535, 32768 + Math.round(v / 1000)); rating[n] = Math.round(+l.slice(a + 1, b) * 10); }
      }
      parentPort.postMessage({ progress: "ratings read" });

      await run("BEGIN");
      const titles = batch("titles", 6, 150), names = batch("names_raw", 3, 250);
      let kept = 0, rows = 0;
      for await (const l of lines(workerData.files.basics)) {
        const c = l.split("\t");
        const k = MOVIE.has(c[1]) ? 1 : SERIES.has(c[1]) ? 2 : 0;
        if (!k || c[4] === "1") continue;
        const n = +c[0].slice(2);
        const year = c[5] === "\\N" ? 0 : +c[5];
        if (n >= kind.length || (!votes[n] && year < thisYear - 1)) continue;
        kind[n] = k; kept++;
        await titles.add(n, k, year, c[6] === "\\N" ? 0 : +c[6], votes[n] < 32768 ? votes[n] : (votes[n] - 32768) * 1000, rating[n]);
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

      // Credits of the kept titles: directors (title.crew) and the first ten cast (principals),
      // as (title, person, role) pairs; then the people's names (name.basics), only theirs.
      const pairs = { t: new Int32Array(1 << 22), p: new Int32Array(1 << 22), r: new Uint8Array(1 << 22), n: 0 };
      const addPair = (t: number, p: number, r: number) => {
        if (pairs.n === pairs.t.length) {
          const grow = <T extends Int32Array | Uint8Array>(a: T): T => { const b = new (a.constructor as any)(a.length * 2); b.set(a); return b; };
          pairs.t = grow(pairs.t); pairs.p = grow(pairs.p); pairs.r = grow(pairs.r);
        }
        pairs.t[pairs.n] = t; pairs.p[pairs.n] = p; pairs.r[pairs.n] = r; pairs.n++;
      };
      const needed = new Map<number, number>(); // person -> name hash (0 until read)
      for await (const l of lines(workerData.files.crew)) {
        const a = l.indexOf("\t"), n = +l.slice(2, a);
        if (n >= kind.length || !kind[n]) continue;
        const d = l.slice(a + 1, l.indexOf("\t", a + 1));
        if (d === "\\N") continue;
        for (const id of d.split(",")) { const p = +id.slice(2); addPair(n, p, 1); needed.set(p, 0); }
      }
      for await (const l of lines(workerData.files.principals)) {
        const a = l.indexOf("\t"), n = +l.slice(2, a);
        if (n >= kind.length || !kind[n]) continue;
        const c = l.split("\t");
        if (+c[1] > 10 || (c[3] !== "actor" && c[3] !== "actress" && c[3] !== "self")) continue;
        const p = +c[2].slice(2);
        addPair(n, p, 2); needed.set(p, 0);
      }
      parentPort.postMessage({ progress: `credits read: ${pairs.n} for ${needed.size} people` });
      for await (const l of lines(workerData.files.names)) {
        const a = l.indexOf("\t"), p = +l.slice(2, a);
        if (needed.has(p)) needed.set(p, person(l.slice(a + 1, l.indexOf("\t", a + 1))));
      }
      // One row per title: its people as 32-bit name hashes, packed (directors first, then
      // cast; the first number counts the directors). A row per credit was 180 MB.
      const order = new Float64Array(pairs.n);
      for (let i = 0; i < pairs.n; i++) order[i] = pairs.t[i] * 8388608 + i; // title, then read order
      order.sort();
      await exec("CREATE TABLE credits (id INTEGER PRIMARY KEY, d BLOB NOT NULL);");
      await run("BEGIN");
      const credits = batch("credits", 2, 300);
      let written = 0;
      for (let i = 0; i < order.length;) {
        const t = Math.floor(order[i] / 8388608);
        const dirs: number[] = [], cast: number[] = [];
        for (; i < order.length && Math.floor(order[i] / 8388608) === t; i++) {
          const j = order[i] % 8388608, h = needed.get(pairs.p[j]);
          if (!h) continue;
          const list = pairs.r[j] === 1 ? dirs : cast;
          if (!list.includes(h)) list.push(h);
        }
        if (!dirs.length && !cast.length) continue;
        await credits.add(t, Buffer.from(Int32Array.from([dirs.length, ...dirs, ...cast]).buffer));
        if (++written % 100_000 === 0) { await credits.flush(); await run("COMMIT"); await run("BEGIN"); }
      }
      await credits.flush(); await run("COMMIT");
      parentPort.postMessage({ progress: `credits packed for ${written} titles` });

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
      workerData: { files, tmp, sqlite3: require.resolve("sqlite3"), keySource: imdbKey.toString(), personSource: personHash.toString() },
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

export interface ImdbMatch {
  imdbId: string; kind: "movie" | "series"; year: number; votes: number; ownName: boolean; leftover: string;
  /** What the portal's people said about it: "director" / "cast" (shared), "against", or "none". */
  evidence: "director" | "cast" | "against" | "none";
}

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

/** IMDb's people for these titles (by tconst number): directors (role 1) and cast (role 2). */
export async function creditsOf(ids: number[]): Promise<Map<number, { h: number; role: number }[]>> {
  const out = new Map<number, { h: number; role: number }[]>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of await all(`SELECT id, d FROM credits WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk).catch(() => [])) {
      const b: Buffer = r.d;
      const v = new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      out.set(r.id, Array.from(v.subarray(1), (h, j) => ({ h, role: j < v[0] ? 1 : 2 })));
    }
  }
  return out;
}

/** People the portal lists for a title ("Christopher Nolan, Emma Thomas"), as evidence. */
export interface PortalPeople {
  directors?: string | string[] | null;
  cast?: string | string[] | null;
  /** The IMDb rating the portal shows (many portals copy IMDb's): a near-fingerprint. */
  imdbRating?: string | number | null;
}

const peopleOf = (v: string | string[] | null | undefined, max: number): number[] => {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/,|\/|;|\|/);
  const out: number[] = [];
  for (const raw of list) {
    const s = String(raw).trim();
    if (s.length < 3 || /^(n\/?a|none|unknown|-+)$/i.test(s)) continue;
    const h = personHash(s);
    if (h && !out.includes(h)) out.push(h);
    if (out.length >= max) break;
  }
  return out;
};

/** The portal's people as name hashes (for peopleEvidence). */
export function portalPeopleHashes(people?: PortalPeople): { directors: number[]; cast: number[] } {
  return { directors: peopleOf(people?.directors, 4), cast: peopleOf(people?.cast, 12) };
}

/**
 * How much the portal's director and cast agree with a candidate's (from IMDb's credits):
 * a shared director +6, a different one -3; each shared cast member +2 (up to +6), none of 3 or
 * more listed -2. Null when either side has nothing to compare (no evidence either way).
 */
export function peopleEvidence(portalDirectors: number[], portalCast: number[], credits: { h: number; role: number }[] | undefined): { score: number; director: number; cast: number } | null {
  if (!credits?.length || (!portalDirectors.length && !portalCast.length)) return null;
  const dirs = new Set(credits.filter((c) => c.role === 1).map((c) => c.h));
  const cast = new Set(credits.filter((c) => c.role === 2).map((c) => c.h));
  let score = 0, director = -1, castHits = -1;
  if (portalDirectors.length && dirs.size) {
    director = portalDirectors.filter((h) => dirs.has(h)).length;
    score += director > 0 ? 6 : -3;
  }
  if (portalCast.length && cast.size) {
    castHits = portalCast.filter((h) => cast.has(h)).length;
    score += castHits > 0 ? Math.min(6, 2 * castHits) : portalCast.length >= 3 ? -2 : 0;
  }
  return director < 0 && castHits < 0 ? null : { score, director, cast: castHits };
}

/**
 * The IMDb title at the start of a portal name, or null. [kind] the portal's type, [year] the
 * portal's year (0 unknown), [people] the portal's director and cast when it sends them.
 */
export async function matchImdb(name: string, kind: "movie" | "series", year: number, people?: PortalPeople): Promise<ImdbMatch | null> {
  if (!imdbIndexReady()) return null;
  const parts = [String(name || "")];
  const m = /^[^:|]{2,40}[:|]\s*(.+)$/.exec(parts[0]);
  if (m) parts.push(m[1]);
  const k = kind === "movie" ? 1 : 2;
  const pDirs = peopleOf(people?.directors, 4), pCast = peopleOf(people?.cast, 12);
  const pRating = Number(people?.imdbRating) > 0 && Number(people?.imdbRating) <= 10 ? Number(people?.imdbRating) : 0;
  // The portal's copy of IMDb's rating against the title's: equal (it moves a little over time)
  // +3, far apart -1.
  const ratingScore = (c: { rating: number }) => (!pRating || !c.rating ? 0 : Math.abs(c.rating / 10 - pRating) <= 0.1 ? 3 : Math.abs(c.rating / 10 - pRating) > 1.5 ? -1 : 0);
  for (const part of parts) {
    const words = [...part.matchAll(WORD)].map((w) => ({ key: imdbKey(w[0]), end: w.index! + w[0].length })).filter((w) => w.key);
    if (!words.length) continue;
    const prefixes: string[] = [];
    for (let n = words.length; n >= 1; n--) prefixes.push(words.slice(0, n).map((w) => w.key).join(" "));
    const rows = await all(
      `SELECT n.key, n.id, n.own, t.kind, t.year, t.endYear, t.votes, t.rating FROM names n JOIN titles t ON t.id = n.id WHERE n.key IN (${prefixes.map(() => "?").join(",")}) AND t.kind = ?`,
      [...prefixes, k],
    );
    if (!rows.length) continue;
    // Credits only when the portal sent people to compare (and the index has them).
    const credits = pDirs.length || pCast.length ? await creditsOf([...new Set(rows.map((r) => r.id as number))]) : new Map();
    const byKey = new Map<string, any[]>();
    for (const r of rows) { let a = byKey.get(r.key); if (!a) byKey.set(r.key, (a = [])); a.push(r); }
    for (let i = 0; i < prefixes.length; i++) {
      const cands = byKey.get(prefixes[i]);
      if (!cands) continue;
      const leftover = part.slice(words[prefixes.length - 1 - i].end);
      if (!onlyTagsLeft(leftover)) continue;
      let best: any = null, bestScore = -Infinity, bestEv: ReturnType<typeof peopleEvidence> = null;
      for (const c of cands) {
        const ev = peopleEvidence(pDirs, pCast, credits.get(c.id));
        const confirmed = !!ev && ev.score > 0;
        const yearOk = !year || !c.year || Math.abs(c.year - year) <= 1 || (k === 2 && year >= c.year && (!c.endYear || year <= c.endYear + 1));
        if (!yearOk && !(confirmed && ev!.director > 0)) continue; // a shared director outweighs a stray year
        if (!c.votes && !(year && c.year === year) && !confirmed) continue; // an unknown title only with the same year or people
        if (ev && ev.score <= -5) continue; // both director and cast say it is another title
        const score = (c.own ? 3 : 1) + (year && c.year === year ? 2 : year && c.year ? 1 : 0) + Math.log10(c.votes + 1) * 0.5 + (ev?.score ?? 0) + ratingScore(c);
        if (score > bestScore) { bestScore = score; best = c; bestEv = ev; }
      }
      if (best) return { imdbId: `tt${String(best.id).padStart(7, "0")}`, kind, year: best.year, votes: best.votes, ownName: !!best.own, leftover: leftover.trim(), evidence: bestEv ? (bestEv.director > 0 ? "director" : bestEv.cast > 0 ? "cast" : "against") : "none" };
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
  people?: PortalPeople,
  tmdb: { find: typeof findTmdbIdByImdb; details: typeof fetchMetaByTmdbId } = { find: findTmdbIdByImdb, details: fetchMetaByTmdbId },
): Promise<TmdbMeta | null> {
  if (!imdbMatchingOn()) return null;
  stats.tried++;
  const m = await matchImdb(name, kind === "movie" ? "movie" : "series", parseInt(year, 10) || 0, people).catch(() => null);
  if (!m) return null;
  stats.matched++;
  const tmdbId = await tmdb.find(m.imdbId, kind).catch(() => null);
  if (!tmdbId) return null;
  const meta = await tmdb.details(kind, tmdbId).catch(() => null);
  if (!meta) return null;
  stats.used++;
  return meta.imdbId ? meta : { ...meta, imdbId: m.imdbId };
}

type Years = { year: number; endYear: number };
/**
 * Whether the portal's year alone (no people) decides between the current match and IMDb's
 * pick: the pick fits it by its own year (a series also by a run that has ended) and has 20
 * votes or more, the current title is 3 years or more away (and, for a series, outside its run),
 * and a year in the name does not disagree with the portal's (either can be the one that is
 * off: an upload year, a re-release). Checked against the portal's people where both exist:
 * 262 confirmed, 4 contradicted.
 */
export function yearDecides(type: "movie" | "series", portalYear: number, nameYear: number | null, now: Years | null, pick: Years | null, pickVotes: number): boolean {
  if (!portalYear || pickVotes < 20 || !now?.year || !pick?.year) return false;
  if (nameYear && Math.abs(nameYear - portalYear) > 1) return false;
  const fits = (t: Years, open: boolean) =>
    Math.abs(t.year - portalYear) <= 1 || (type === "series" && portalYear >= t.year && (t.endYear ? portalYear <= t.endYear + 1 : open));
  return fits(pick, false) && !fits(now, true) && Math.abs(now.year - portalYear) >= 3;
}

/** An indexed IMDb title's years (start, and end for a series), or null when not indexed. */
export async function imdbTitleYears(imdbId: string): Promise<{ year: number; endYear: number } | null> {
  if (!/^tt\d+$/.test(imdbId)) return null;
  const [r] = await all("SELECT year, endYear FROM titles WHERE id = ?", [parseInt(imdbId.slice(2), 10)]).catch(() => []);
  return r ? { year: r.year, endYear: r.endYear } : null;
}
