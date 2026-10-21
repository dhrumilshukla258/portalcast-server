// People search (`GET /api/v2/search/people?q=`): actors, directors, creators and writers
// by name, answered from memory.
//
// Who is in it: everyone with at least one "major" credit on a catalog title, i.e. a
// director, creator, or one of the first 10 billed cast members (~258k of ~412k people).
// title_people only holds catalog titles (tidyPeople removes the rest), so no join with
// content_meta is needed.
//
// Memory layout: packed, not one object or string per person. Every text lives in one byte
// buffer with an offsets array (CSR), numbers in typed arrays:
//   norms   normalized names, ASCII [a-z0-9 ] (what queries compare against)
//   names   display names, UTF-8 (decoded only for the ~30 hits returned)
//   photos  TMDB paths packed as "/x.jpg", UTF-8 (empty = none)
//   vocab   sorted name words, plus adjacent word pairs joined ("shah rukh" -> "shahrukh"),
//           ASCII; postings[vocabOff..] lists the people with that word
// ~20 MB for the real catalog and next to nothing for the garbage collector to walk (a
// version with JS strings and arrays took 45 MB of heap).
// People are numbered by popularity (major credits, most first), so every postings list
// is in popularity order: a one- or two-letter prefix ("de", "to") stops after the most
// popular SHORT_PREFIX_CAP people instead of touching a third of the index.
//
// Building happens in a worker thread with its own read-only SQLite connection: one table
// scan in storage order (title_people NOT INDEXED; walking it through an index took
// 16-22 s, the scan ~4-6 s), then normalizing and sorting. The buffers are transferred
// (zero copy) and swapped in; the main thread never blocks and searches keep using the
// previous index meanwhile. Built 30 s after start and again when people change (the
// Discover cache clears after enrichment; people tidy), at most every 15 minutes.
//
// Queries: per word, a binary search over the vocabulary for the prefix range (3 = whole
// word, 2 = prefix), or, when nothing starts with it, the words one edit away (1); every
// word must match. Ranking: per-word quality, the whole name equal to / starting with the
// query, then how much of the catalog the person leads (log), then shorter names. Answers
// are cached per normalized query until the next index swap.

import { Worker } from "worker_threads";
import { databasePath } from "@/infra/paths";
import { logger } from "@/infra/logger";
import { editsOne, normalizeText } from "@/content/searchIndex";
import { unpackPhoto } from "@/content/people";

const KIND_CAST = 1, KIND_DIRECTOR = 2, KIND_CREATOR = 4, KIND_WRITER = 8;
const MIN_FUZZY_LEN = 4;
/** One- and two-letter prefixes only look at this many of the most popular people. */
const SHORT_PREFIX_CAP = 20_000;

export interface PersonHit {
  id: number;
  name: string;
  photo: string | null;
  /** "Actor", "Director", "Actor · Director"... from their credits here. */
  knownFor: string;
  /** Major credits in the catalog (lead cast, director, creator). */
  titles: number;
}

export interface PeopleResult {
  people: PersonHit[];
  /** The person the query clearly names ("shah rukh", "mohanlal"); null when ambiguous ("khan"). */
  featured: PersonHit | null;
}

function kindsLabel(k: number): string {
  const out: string[] = [];
  if (k & KIND_CAST) out.push("Actor");
  if (k & KIND_DIRECTOR) out.push("Director");
  if (k & KIND_CREATOR) out.push("Creator");
  if (k & KIND_WRITER) out.push("Writer");
  return out.join(" · ") || "Crew";
}

/** What the worker sends back: every field is a typed array over a transferable buffer. */
interface Packed {
  count: number;
  ids: Int32Array;
  weight: Int32Array;
  kinds: Uint8Array;
  norms: Uint8Array; normOff: Int32Array;
  names: Uint8Array; nameOff: Int32Array;
  photos: Uint8Array; photoOff: Int32Array;
  vocab: Uint8Array; vocabOff: Int32Array;
  postings: Int32Array; postOff: Int32Array;
}

const utf8 = new TextDecoder();
const ascii = new TextEncoder();

class PeopleIndex {
  private readonly vocabCount: number;
  // Per-query scratch, allocated once per index: a query allocates nothing proportional to
  // its matches (a common word like "khan" touches tens of thousands of people), so there is
  // no garbage-collection pause under load. Safe: queries run one at a time on the event loop.
  private readonly mark: Int8Array;     // best match quality of person d for the current word
  private readonly total: Int32Array;   // summed quality over the words so far
  private readonly touched: Int32Array; // people marked for the current word
  private readonly cand: Int32Array;    // people matching every word so far

  constructor(private readonly p: Packed) {
    this.vocabCount = p.vocabOff.length - 1;
    this.mark = new Int8Array(p.count);
    this.total = new Int32Array(p.count);
    this.touched = new Int32Array(p.count);
    this.cand = new Int32Array(p.count);
  }

  get size(): number { return this.p.count; }

  /** Byte comparison of vocab term `i` with `q` (ASCII, so it orders like the JS sort). */
  private cmpTerm(i: number, q: Uint8Array): number {
    const { vocab, vocabOff } = this.p;
    const a = vocabOff[i], len = vocabOff[i + 1] - a;
    const n = Math.min(len, q.length);
    for (let k = 0; k < n; k++) { const d = vocab[a + k] - q[k]; if (d !== 0) return d; }
    return len - q.length;
  }

  /** First term >= q. */
  private lowerBound(q: Uint8Array): number {
    let lo = 0, hi = this.vocabCount;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cmpTerm(mid, q) < 0) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** Term `i` starts with q. */
  private hasPrefix(i: number, q: Uint8Array): boolean {
    const { vocab, vocabOff } = this.p;
    const a = vocabOff[i];
    if (vocabOff[i + 1] - a < q.length) return false;
    for (let k = 0; k < q.length; k++) if (vocab[a + k] !== q[k]) return false;
    return true;
  }

  /** [lo, hi) of the terms starting with q (they are contiguous in sorted order). */
  private prefixRange(q: Uint8Array): [number, number] {
    const lo = this.lowerBound(q);
    let a = lo, b = this.vocabCount;
    while (a < b) { const mid = (a + b) >> 1; if (this.hasPrefix(mid, q)) a = mid + 1; else b = mid; }
    return [lo, a];
  }

  private exactTerm(q: Uint8Array): number {
    const i = this.lowerBound(q);
    return i < this.vocabCount && this.cmpTerm(i, q) === 0 ? i : -1;
  }

  /** Doc d's normalized name equals q (0), starts with q then a space (1), starts with q (2), else -1. */
  private nameVs(d: number, q: Uint8Array): number {
    const { norms, normOff } = this.p;
    const a = normOff[d], len = normOff[d + 1] - a;
    if (len < q.length) return -1;
    for (let k = 0; k < q.length; k++) if (norms[a + k] !== q[k]) return -1;
    if (len === q.length) return 0;
    return norms[a + q.length] === 32 ? 1 : 2;
  }

  private hit(d: number): PersonHit {
    const { ids, names, nameOff, photos, photoOff, kinds, weight } = this.p;
    const photo = photoOff[d + 1] > photoOff[d] ? utf8.decode(photos.subarray(photoOff[d], photoOff[d + 1])) : null;
    return {
      id: ids[d],
      name: utf8.decode(names.subarray(nameOff[d], nameOff[d + 1])),
      photo: unpackPhoto(photo),
      knownFor: kindsLabel(kinds[d]),
      titles: weight[d],
    };
  }

  /**
   * Ranked people. A word that only matches one edit away is tried only when nothing starts
   * with it; if that finds nobody, a second pass also allows one typo in every word that has
   * prefix matches ("fahad fasil" -> Fahadh Faasil, while "fasil..." names exist).
   */
  search(query: string, limit: number): PeopleResult {
    const first = this.run(query, limit, false);
    return first.people.length ? first : this.run(query, limit, true);
  }

  private run(query: string, limit: number, typoEverywhere: boolean): PeopleResult {
    const words = normalizeText(query).split(" ").filter(Boolean);
    if (words.length === 0) return { people: [], featured: null };
    const { postings, postOff } = this.p;
    const { mark, total, touched, cand } = this;
    let candLen = -1; // -1: no word processed yet
    for (const w of words) {
      const qb = ascii.encode(w);
      const cap = w.length <= 2 ? SHORT_PREFIX_CAP : 0x7fffffff;
      let tn = 0;
      const touch = (vi: number, q: number) => {
        for (let k = postOff[vi], end = postOff[vi + 1]; k < end; k++) {
          const d = postings[k];
          if (d >= cap) break; // lists are in popularity order
          if (mark[d] === 0) touched[tn++] = d;
          if (mark[d] < q) mark[d] = q;
        }
      };
      const [lo, hi] = this.prefixRange(qb);
      for (let vi = lo; vi < hi; vi++) touch(vi, this.cmpTerm(vi, qb) === 0 ? 3 : 2);
      if ((lo === hi || typoEverywhere) && w.length >= MIN_FUZZY_LEN) {
        const seen = new Set<number>();
        for (const e of editsOne(w)) {
          const vi = this.exactTerm(ascii.encode(e));
          if (vi >= 0 && !seen.has(vi)) { seen.add(vi); touch(vi, 1); }
        }
      }
      if (tn === 0) return { people: [], featured: null };
      if (candLen < 0) {
        cand.set(touched.subarray(0, tn));
        candLen = tn;
        for (let k = 0; k < candLen; k++) total[cand[k]] = mark[cand[k]];
      } else {
        let out = 0;
        for (let k = 0; k < candLen; k++) { const d = cand[k]; if (mark[d] > 0) { total[d] += mark[d]; cand[out++] = d; } }
        candLen = out;
      }
      for (let k = 0; k < tn; k++) mark[touched[k]] = 0;
      if (candLen === 0) return { people: [], featured: null };
    }

    const qJoined = ascii.encode(words.join(" "));
    const allWhole = 3 * words.length;
    const { weight, normOff } = this.p;
    // Top `limit` by score, kept in a small sorted array (no full sort of a large candidate set).
    const topD: number[] = [], topS: number[] = [], topStrong: boolean[] = [];
    for (let k = 0; k < candLen; k++) {
      const d = cand[k];
      const vs = this.nameVs(d, qJoined);
      let s = total[d] * 60;
      if (vs === 0) s += 250;
      // "khan" alone: where in the name the word sits barely matters (Khan Chittenden must not
      // outrank Salman Khan); "tom ha" names the start of a full name.
      else if (vs === 1) s += words.length > 1 ? 150 : 40;
      else if (vs === 2 && qJoined.length >= 3) s += 100;
      s += Math.log2(1 + weight[d]) * 40;
      s -= (normOff[d + 1] - normOff[d]) * 0.5;
      if (topD.length === limit && s <= topS[limit - 1]) continue;
      let i = topD.length;
      while (i > 0 && topS[i - 1] < s) i--;
      topD.splice(i, 0, d); topS.splice(i, 0, s);
      // Strong: the name is the query, or starts with it ("tom han" while typing Tom Hanks).
      topStrong.splice(i, 0, vs === 0 || vs === 1 || (words.length >= 2 && (vs === 2 || total[d] === allWhole)));
      if (topD.length > limit) { topD.pop(); topS.pop(); topStrong.pop(); }
    }
    const people = topD.map((d) => this.hit(d));
    // Featured: the top hit names the query and leads every other hit at least two to one
    // ("mohanlal" yes; "mohan" no, Mohanlal outweighs the actor named Mohan; "tom" no).
    let featured: PersonHit | null = null;
    if (topD.length && topStrong[0] && topD.every((d, i) => i === 0 || weight[topD[0]] >= 2 * weight[d])) featured = people[0];
    return { people, featured };
  }
}

// ── Worker: reads and packs off the main thread ───────────────────────────────
// Runs from source text (`eval`), so it needs no separate build entry; normalizeText is
// passed in as source too, so queries and index use exactly the same normalization.
function workerMain(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { parentPort, workerData } = require("worker_threads");
  const sqlite3 = require(workerData.sqlite3);
  const normalize = new Function(`return (${workerData.normalizeSource})`)() as (s: string) => string;
  const conn = new sqlite3.Database(workerData.dbPath, sqlite3.OPEN_READONLY, (openErr: any) => {
    if (openErr) { parentPort.postMessage({ error: String(openErr.message || openErr) }); return; }
    conn.configure("busyTimeout", 5000);
    conn.all(workerData.sql, (err: any, rows: any[]) => conn.close(() => {
      if (err) { parentPort.postMessage({ error: String(err.message || err) }); return; }
      const readMs = Date.now() - workerData.started;
      rows.sort((a, b) => b.n - a.n || a.id - b.id); // doc ids in popularity order
      const n = rows.length;
      const enc = new TextEncoder();
      const ids = new Int32Array(n), weight = new Int32Array(n), kinds = new Uint8Array(n);
      const normOff = new Int32Array(n + 1), nameOff = new Int32Array(n + 1), photoOff = new Int32Array(n + 1);
      const normParts: string[] = new Array(n);
      const nameBytes: Uint8Array[] = new Array(n), photoBytes: Uint8Array[] = new Array(n);
      const termDocs = new Map<string, number[]>();
      let normLen = 0, nameLen = 0, photoLen = 0;
      for (let d = 0; d < n; d++) {
        const r = rows[d];
        ids[d] = r.id; weight[d] = r.n; kinds[d] = r.k;
        const norm = normalize(String(r.name || ""));
        normParts[d] = norm; normOff[d] = normLen; normLen += norm.length;
        nameBytes[d] = enc.encode(String(r.name || "")); nameOff[d] = nameLen; nameLen += nameBytes[d].length;
        photoBytes[d] = enc.encode(r.photo || ""); photoOff[d] = photoLen; photoLen += photoBytes[d].length;
        const words = norm ? norm.split(" ") : [];
        const terms = new Set<string>(words);
        for (let i = 0; i + 1 < words.length; i++) terms.add(words[i] + words[i + 1]);
        for (const t of terms) { const l = termDocs.get(t); if (l) l.push(d); else termDocs.set(t, [d]); }
      }
      normOff[n] = normLen; nameOff[n] = nameLen; photoOff[n] = photoLen;
      const norms = enc.encode(normParts.join(""));
      const names = new Uint8Array(nameLen), photos = new Uint8Array(photoLen);
      for (let d = 0; d < n; d++) { names.set(nameBytes[d], nameOff[d]); photos.set(photoBytes[d], photoOff[d]); }
      const terms = [...termDocs.keys()].sort();
      const vocabOff = new Int32Array(terms.length + 1), postOff = new Int32Array(terms.length + 1);
      let vLen = 0, pLen = 0;
      for (let i = 0; i < terms.length; i++) { vocabOff[i] = vLen; vLen += terms[i].length; postOff[i] = pLen; pLen += termDocs.get(terms[i])!.length; }
      vocabOff[terms.length] = vLen; postOff[terms.length] = pLen;
      const vocab = enc.encode(terms.join(""));
      const postings = new Int32Array(pLen);
      for (let i = 0; i < terms.length; i++) postings.set(termDocs.get(terms[i])!, postOff[i]); // ascending = popularity order
      const packed = { count: n, ids, weight, kinds, norms, normOff, names, nameOff, photos, photoOff, vocab, vocabOff, postings, postOff };
      const transfer = Object.values(packed).filter((v: any) => v && v.buffer).map((v: any) => v.buffer);
      parentPort.postMessage({ packed, readMs, terms: terms.length }, transfer);
    }));
  });
}

const BUILD_SQL = `SELECT p.id, p.name, p.photo, a.n, a.k FROM (
    SELECT personId,
           SUM(CASE WHEN kind IN ('director', 'creator') OR (kind = 'cast' AND sortOrder < 10) THEN 1 ELSE 0 END) AS n,
           MAX(CASE kind WHEN 'cast' THEN ${KIND_CAST} ELSE 0 END)
         | MAX(CASE kind WHEN 'director' THEN ${KIND_DIRECTOR} ELSE 0 END)
         | MAX(CASE kind WHEN 'creator' THEN ${KIND_CREATOR} ELSE 0 END)
         | MAX(CASE kind WHEN 'writer' THEN ${KIND_WRITER} ELSE 0 END) AS k
    FROM title_people NOT INDEXED GROUP BY personId
  ) a JOIN people p ON p.id = a.personId WHERE a.n > 0`;

function buildInWorker(): Promise<{ packed: Packed; readMs: number; terms: number }> {
  return new Promise((resolve, reject) => {
    // `var __name`: esbuild (tsx, tsup) may wrap named functions in a __name() helper that
    // does not exist inside the eval'd worker.
    const source = `var __name = (f) => f;\n(${workerMain.toString()})();`;
    const worker = new Worker(source, {
      eval: true,
      workerData: {
        dbPath: databasePath,
        sqlite3: require.resolve("sqlite3"),
        normalizeSource: normalizeText.toString(),
        sql: BUILD_SQL,
        started: Date.now(),
      },
    });
    let done = false;
    // Never terminate() it: killing the thread while sqlite3 closes its connection aborts the
    // whole process. It posts after closing and then exits by itself.
    worker.once("message", (m: any) => {
      done = true;
      if (m.error) reject(new Error(m.error)); else resolve(m);
    });
    worker.once("error", (e) => { if (!done) { done = true; reject(e); } });
    worker.once("exit", (code) => { if (!done) { done = true; reject(new Error(`worker exited (${code})`)); } });
  });
}

// ── Index lifecycle and the query cache ──────────────────────────────────────

let index: PeopleIndex | null = null;
let building = false;
let dirty = false;
let lastBuild = 0;
let timer: NodeJS.Timeout | null = null;
const MIN_REBUILD_MS = 15 * 60 * 1000;

/** Answers per normalized query + limit, for the current index (cleared on swap). LRU. */
const answers = new Map<string, PeopleResult>();
const MAX_ANSWERS = 5000;

/** Builds a new index in a worker and swaps it in. */
export async function buildPeopleIndex(): Promise<void> {
  if (building) { dirty = true; return; }
  building = true;
  dirty = false;
  const t0 = Date.now();
  try {
    const { packed, readMs, terms } = await buildInWorker();
    index = new PeopleIndex(packed);
    answers.clear();
    lastBuild = Date.now();
    const mb = Object.values(packed).reduce((s: number, v: any) => s + (v?.byteLength ?? 0), 0) / 1e6;
    logger.info(`[people] search index: ${packed.count} people, ${terms} words, ${mb.toFixed(1)} MB (read ${readMs} ms, ready in ${lastBuild - t0} ms, off the main thread)`);
  } catch (e: any) {
    logger.warn(`[people] search index build failed: ${e?.message ?? e}`);
  } finally {
    building = false;
  }
}

/** People data changed: rebuild soon, at most every 15 minutes. */
export function markPeopleChanged(): void {
  dirty = true;
  if (timer) return;
  const wait = Math.max(60_000, lastBuild + MIN_REBUILD_MS - Date.now());
  timer = setTimeout(() => {
    timer = null;
    if (dirty) void buildPeopleIndex();
  }, wait);
  timer.unref?.();
}

/** Ranked people for `query` (cached); empty until the first build finishes. */
export function searchPeople(query: string, limit = 30): PeopleResult {
  const norm = normalizeText(query);
  if (!index || norm.length < 2) return { people: [], featured: null };
  const key = `${limit}|${norm}`;
  const cached = answers.get(key);
  if (cached) { answers.delete(key); answers.set(key, cached); return cached; }
  const result = index.search(norm, limit);
  answers.set(key, result);
  if (answers.size > MAX_ANSWERS) answers.delete(answers.keys().next().value as string);
  return result;
}

export function peopleIndexReady(): boolean { return index !== null; }
