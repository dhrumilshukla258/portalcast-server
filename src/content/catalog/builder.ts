// Catalog snapshot builder (plan, Phase 1). Runs in a worker thread with its own read-only
// SQLite connection and returns packed sections (typed arrays over transferable buffers).
//
// Layout rules, each measured on the live data before it was chosen:
// - Rows are read a page at a time, and SQLite packs each page into one JSON text
//   (json_group_array of json_array per row): the driver then makes one string per page instead
//   of one JS value per cell, which was 18 of the 31 s (measured: 18 s -> 5.3 s for the same
//   rows). Fixed-width columns are allocated once at their exact size from a COUNT(*) first.
// - Text is stored once however many rows carry it (the same plot on three IPTV copies, the
//   same poster path) in a pool of 8 MB chunks; a row holds a 32-bit pool id. Chunks are never
//   copied or concatenated: the first build that doubled and copied one big buffer peaked at
//   +934 MB. A pooled text is stored as its global start (the top bits pick the chunk); texts
//   are laid out back to back, so a text ends where the next one starts, or at its chunk's end.
// - Interning uses an open-addressing table of 32-bit slots, not a Map: a Map of 2.2 million
//   strings took most of a 164 MB worker heap and most of the 30 s.
// - IPTV list entries are stored by shape: an entry is its key list (one of four shapes on the
//   live data) plus each value's JSON text, pooled. The reader rebuilds the exact JSON. Raw
//   JSON per entry was 60 MB, a third of it the same key names repeated 132k times.
// - Title search (the "All" list search) is packed here with the same normalizer and terms as
//   content/searchIndex.ts: a sorted ASCII vocabulary, postings by list entry, and each entry's
//   normalized title and year. Readers answer per type and per visible category from it.
// - Columns that are mostly NULL are sparse (person details: filled for the people whose page
//   was opened). Whole-number columns are stored in 32 or 16 bits when every value fits.
// - One read transaction: the snapshot is one consistent moment of the database, and its
//   version is the change-log position read inside that transaction.
// - Values are kept as SQLite returns them (text, numbers, NULL as pool id 0 / NaN); dates
//   become epoch milliseconds. Readers convert; nothing is reinterpreted here.
//
// The worker runs from source text (`eval`) so it needs no separate build entry; it must not
// be terminate()d while sqlite3 holds a connection (that aborts the whole process). It closes
// the connection, posts, and exits by itself.

import { Worker } from "worker_threads";
import { normalizeText } from "../searchIndex";

export interface ColumnSpec { name: string; kind: "text" | "num" | "date" }

export interface BuildInput {
  dbPath: string;
  copyColumns: ColumnSpec[];
  /** Category ids in display order, per type (from readGenres: one source of that order). */
  genres: { movie: string[]; series: string[] };
  /** Chunk size of pooled text, 2^chunkBits bytes (tests use tiny chunks); CHUNK_BITS by default. */
  chunkBits?: number;
}

export type Section = Uint8Array | Uint16Array | Int16Array | Int32Array | Uint32Array | Float64Array;

/** NULL in a whole-number column stored as Int32Array (a Float64Array column uses NaN). */
export const INT_NULL = -2147483648;

/** Hash of the sections, checked when a file is loaded. It only has to catch a damaged or
 *  truncated file (whoever can write the data folder can write the database too): sha1 is
 *  2.2x faster than sha256 here (393 vs 865 ms on 222 MB). */
export const CHECKSUM = "sha1";

export interface BuildOutput {
  version: number;
  sections: Record<string, Section>;
  counts: Record<string, number>;
  /** Milliseconds per build stage. */
  stages: Record<string, number>;
  readMs: number;
  heapMb: number;
  /** CHECKSUM of the sections in name order, as written to the file. */
  checksum: string;
}

/** Chunk size of pooled text: 2^23 bytes. Stored in the snapshot (section meta.chunkBits). */
export const CHUNK_BITS = 23;

function workerMain(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { parentPort, workerData } = require("worker_threads");
  const sqlite3 = require(workerData.sqlite3);
  const zlib = require("zlib");
  const input = workerData.input;
  const CHUNK = 1 << workerData.chunkBits;
  const started = Date.now();
  const stages: Record<string, number> = {};
  let stageAt = started;
  const stage = (name: string) => { const now = Date.now(); stages[name] = now - stageAt; stageAt = now; };
  const enc = new TextEncoder();

  // Fixed-size column (exact length known from COUNT(*)), or growable when it is not.
  const fixed = (Ctor: any, n: number) => {
    const arr = new Ctor(n); let len = 0;
    return { push(v: number) { arr[len++] = v; }, get length() { return len; }, out() { return len === arr.length ? arr : arr.slice(0, len); } };
  };
  const growable = (Ctor: any, initial = 1 << 14) => {
    let arr = new Ctor(initial), len = 0;
    return {
      push(v: number) { if (len === arr.length) { const next = new Ctor(Math.ceil(arr.length * 1.5)); next.set(arr); arr = next; } arr[len++] = v; },
      get length() { return len; },
      out() { const r = arr.slice(0, len); arr = new Ctor(0); return r; },
    };
  };

  // Whole numbers only (NaN = NULL), all inside int32: Int32Array with INT_NULL for NULL.
  const INT_NULL = -2147483648;
  const narrowNum = (f: Float64Array): Float64Array | Int32Array => {
    for (let i = 0; i < f.length; i++) { const v = f[i]; if (!Number.isNaN(v) && (!Number.isInteger(v) || v <= INT_NULL || v > 2147483647)) return f; }
    const out = new Int32Array(f.length);
    for (let i = 0; i < f.length; i++) out[i] = Number.isNaN(f[i]) ? INT_NULL : f[i];
    return out;
  };
  // Int32 values that all fit in 16 bits.
  const narrowInt = (a: Int32Array): Int32Array | Int16Array => {
    for (let i = 0; i < a.length; i++) if (a[i] < -32768 || a[i] > 32767) return a;
    return Int16Array.from(a);
  };

  // Chunked byte store: each piece stays inside one chunk; (start, length) per piece.
  const chunkStore = () => {
    const chunks: Uint8Array[] = [new Uint8Array(CHUNK)];
    let pos = 0;
    return {
      /** Appends bytes[0..n) and returns its global start. */
      add(bytes: Uint8Array, n: number): number {
        if (n > CHUNK) throw new Error(`a text of ${n} bytes is longer than a snapshot chunk`);
        if (pos + n > CHUNK || pos === CHUNK) {
          // A view of the used part: a text ends where the next one starts or at its chunk's end.
          chunks[chunks.length - 1] = chunks[chunks.length - 1].subarray(0, pos);
          chunks.push(new Uint8Array(CHUNK)); pos = 0;
        }
        const c = chunks.length - 1;
        chunks[c].set(bytes.subarray(0, n), pos);
        const start = c * CHUNK + pos;
        pos += n;
        return start;
      },
      chunk(start: number) { return chunks[Math.floor(start / CHUNK)]; },
      /** Global position after the last piece. */
      get end() { return (chunks.length - 1) * CHUNK + pos; },
      /** The chunks, each trimmed to what is used. */
      out() { const last = chunks.length - 1; chunks[last] = chunks[last].slice(0, pos); return chunks.splice(0); },
    };
  };

  // ── string pool with an open-addressing intern table ──────────────────────────
  // id 0 = NULL. Per id: hash and global start (the length follows from the next start, as the
  // reader does it). `slots` holds ids (0 = empty), probed linearly; it doubles when half full.
  const pool = chunkStore();
  let cap = 1 << 20, count = 1;
  let hashes = new Uint32Array(cap), starts = new Uint32Array(cap);
  let slots = new Int32Array(1 << 21), mask = slots.length - 1;
  let scratch = new Uint8Array(1 << 16);
  const fnv = (b: Uint8Array, n: number) => { let h = 2166136261; for (let i = 0; i < n; i++) h = Math.imul(h ^ b[i], 16777619); return h >>> 0; };
  const ensureCap = () => {
    if (count < cap) return;
    cap = Math.ceil(cap * 1.5);
    const h = new Uint32Array(cap); h.set(hashes); hashes = h;
    const st = new Uint32Array(cap); st.set(starts); starts = st;
  };
  const rehash = () => {
    const bigger = new Int32Array(slots.length * 2), bm = bigger.length - 1;
    for (let k = 0; k < slots.length; k++) {
      const id = slots[k]; if (!id) continue;
      let j = hashes[id] & bm; while (bigger[j]) j = (j + 1) & bm; bigger[j] = id;
    }
    slots = bigger; mask = bm;
  };
  const same = (id: number, b: Uint8Array, n: number) => {
    const st = starts[id], c = pool.chunk(st), at = st % CHUNK;
    // Ends where the next text starts, or at its chunk's (trimmed) end if that one opened a new chunk.
    const len = Math.min((id + 1 < count ? starts[id + 1] : pool.end) - st, c.length - at);
    if (len !== n) return false;
    for (let i = 0; i < n; i++) if (c[at + i] !== b[i]) return false;
    return true;
  };
  const intern = (v: any): number => {
    if (v === null || v === undefined) return 0;
    const str = typeof v === "string" ? v : String(v);
    if (scratch.length < str.length * 3) scratch = new Uint8Array(str.length * 3 + 16);
    const n = enc.encodeInto(str, scratch).written;
    const h = fnv(scratch, n);
    let k = h & mask;
    for (;;) {
      const id = slots[k];
      if (!id) break;
      if (hashes[id] === h && same(id, scratch, n)) return id;
      k = (k + 1) & mask;
    }
    ensureCap();
    const id = count++;
    hashes[id] = h; starts[id] = pool.add(scratch, n);
    slots[k] = id;
    if (count * 2 > slots.length) rehash();
    return id;
  };

  const conn = new sqlite3.Database(input.dbPath, sqlite3.OPEN_READONLY, (openErr: any) => {
    if (openErr) { parentPort.postMessage({ error: String(openErr.message || openErr) }); return; }
    conn.configure("busyTimeout", 5000);
    const get = (sql: string, params: any[] = []) => new Promise<any>((resolve, reject) => conn.get(sql, params, (err: any, r: any) => (err ? reject(err) : resolve(r))));
    // Pages of PAGE rows in rowid (storage) order, inside the one read transaction. Not
    // `each`: sqlite3 fetches rows faster than they are packed and queues them in native
    // memory (measured: +863 MB peak with a 32 MB worker heap). A page bounds that queue.
    // Each row arrives as an array: [rowid, ...columns in the order asked for], each value as
    // the driver returns it. SQLite's JSON writes a REAL with 15 significant digits (0.1 + 0.2
    // came back as 0.3), so a REAL is sent as {"r": "<17 digits>"}, which round-trips to the same
    // double; a text value is never an object, so the tag cannot be mistaken.
    const PAGE = 4000;
    const scan = async (columns: string[], table: string, onRow: (r: any[]) => void) => {
      const list = columns.map((c) => `\`${c}\``).join(", ");
      const exact = columns.map((c) => `CASE WHEN typeof(\`${c}\`) = 'real' THEN json_object('r', printf('%!.17g', \`${c}\`)) ELSE \`${c}\` END`).join(", ");
      let after = -9007199254740991;
      for (;;) {
        const page = await get(`SELECT json_group_array(json_array(_rid, ${exact})) AS j FROM (SELECT rowid AS _rid, ${list} FROM \`${table}\` WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE})`, [after]);
        const rows: any[][] = JSON.parse(page.j);
        for (const r of rows) {
          for (let i = 1; i < r.length; i++) { const v = r[i]; if (v !== null && typeof v === "object") r[i] = Number(v.r); }
          onRow(r);
        }
        if (rows.length < PAGE) return;
        after = rows[rows.length - 1][0];
      }
    };
    const run = (sql: string) => new Promise<void>((resolve, reject) => conn.run(sql, (err: any) => (err ? reject(err) : resolve())));
    const countOf = async (table: string) => Number((await get(`SELECT COUNT(*) AS n FROM \`${table}\``)).n) || 0;

    (async () => {
      await run("BEGIN"); // one consistent moment for every read below
      const hasLog = await get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'catalog_changes'");
      const version = hasLog ? Number((await get("SELECT IFNULL(MAX(seq), 0) AS v FROM catalog_changes")).v) || 0 : 0;
      const sections: Record<string, any> = {};
      const counts: Record<string, number> = {};

      // ── copies: one row per content_meta row (an IPTV or local copy of a title) ──
      const nCopies = await countOf("content_meta");
      const cols = input.copyColumns as { name: string; kind: string }[];
      const colArr = cols.map((c) => (c.kind === "text" ? fixed(Uint32Array, nCopies) : fixed(Float64Array, nCopies)));
      const copyIdStr: string[] = [];
      const typeCode = new Uint8Array(nCopies);
      const idAt = 1 + cols.findIndex((c) => c.name === "id"), typeAt = 1 + cols.findIndex((c) => c.name === "type");
      if (idAt === 0 || typeAt === 0) throw new Error("copy columns must include id and type");
      await scan(cols.map((c) => c.name), "content_meta", (r) => {
        const i = copyIdStr.length;
        if (i >= nCopies) throw new Error("content_meta changed size during the build");
        copyIdStr.push(String(r[idAt]));
        typeCode[i] = r[typeAt] === "series" ? 2 : 1;
        for (let k = 0; k < cols.length; k++) {
          const v = r[k + 1];
          const kind = cols[k].kind;
          if (kind === "text") colArr[k].push(intern(v));
          else if (kind === "date") colArr[k].push(v === null || v === undefined ? NaN : Date.parse(String(v).replace(/^(\S+) (\S+) ?([+-]\d\d:?\d\d|Z)?$/, (_m: string, d: string, t: string, z?: string) => `${d}T${t}${z ?? "Z"}`)));
          else colArr[k].push(v === null || v === undefined ? NaN : Number(v));
        }
      });
      const copyCount = copyIdStr.length;
      counts.copies = copyCount;
      cols.forEach((c, k) => { sections[`copy.${c.name}`] = colArr[k].out(); });
      sections["copy.typeCode"] = copyCount === nCopies ? typeCode : typeCode.slice(0, copyCount);
      const byId = Int32Array.from(copyIdStr.keys()).sort((a, b) => (copyIdStr[a] < copyIdStr[b] ? -1 : copyIdStr[a] > copyIdStr[b] ? 1 : 0));
      sections["copy.byId"] = byId;
      const tmdbCol = sections["copy.tmdbId"] as Float64Array;
      const withTmdb: number[] = [];
      for (let i = 0; i < copyCount; i++) if (!Number.isNaN(tmdbCol[i])) withTmdb.push(i);
      withTmdb.sort((a, b) => typeCode[a] - typeCode[b] || tmdbCol[a] - tmdbCol[b] || a - b);
      sections["copy.byTmdb"] = Int32Array.from(withTmdb);
      cols.forEach((c) => { if (c.kind === "num") sections[`copy.${c.name}`] = narrowNum(sections[`copy.${c.name}`]); });
      const idLookup = (id: string) => { // binary search in byId (no 132k-entry map)
        let lo = 0, hi = byId.length - 1;
        while (lo <= hi) { const m = (lo + hi) >> 1; const s = copyIdStr[byId[m]]; if (s === id) return byId[m]; if (s < id) lo = m + 1; else hi = m - 1; }
        return -1;
      };
      stage("copies");

      // ── tags: per kind a value dictionary, each copy's values, each value's copies ──
      for (const [kind, table] of [["genre", "content_genres"], ["country", "content_countries"], ["theme", "content_themes"]]) {
        const n0 = await countOf(table);
        const dict = new Map<string, number>();
        const dictIds: number[] = [];
        const pc = fixed(Int32Array, n0), pv = fixed(Int32Array, n0);
        await scan(["contentId", "value"], table, (r) => {
          const c = idLookup(String(r[1]));
          if (c < 0) return; // orphan tag (the integrity job removes these)
          let v = dict.get(String(r[2]));
          if (v === undefined) { v = dictIds.length; dict.set(String(r[2]), v); dictIds.push(intern(r[2])); }
          pc.push(c); pv.push(v);
        });
        const n = pc.length, copies = pc.out(), vals = pv.out();
        const copyOff = new Int32Array(copyCount + 1);
        for (let k = 0; k < n; k++) copyOff[copies[k] + 1]++;
        for (let i = 0; i < copyCount; i++) copyOff[i + 1] += copyOff[i];
        const cur = copyOff.slice(0, copyCount), copyVals = new Int32Array(n);
        for (let k = 0; k < n; k++) copyVals[cur[copies[k]]++] = vals[k];
        const valOff = new Int32Array(dictIds.length + 1);
        for (let k = 0; k < n; k++) valOff[vals[k] + 1]++;
        for (let i = 0; i < dictIds.length; i++) valOff[i + 1] += valOff[i];
        const vcur = valOff.slice(0, dictIds.length), valCopies = new Int32Array(n);
        for (let c = 0; c < copyCount; c++) for (let k = copyOff[c]; k < copyOff[c + 1]; k++) valCopies[vcur[copyVals[k]]++] = c;
        sections[`tag.${kind}.dict`] = Uint32Array.from(dictIds);
        sections[`tag.${kind}.copyOff`] = copyOff;
        sections[`tag.${kind}.copyVals`] = copyVals;
        sections[`tag.${kind}.valOff`] = valOff;
        sections[`tag.${kind}.valCopies`] = valCopies;
        counts[`tags.${kind}`] = n;
      }
      stage("tags");

      // ── people (rowid order = ascending id, so ids are binary-searchable as stored) ──
      const nPeople = await countOf("people");
      const pId = fixed(Int32Array, nPeople), pTmdb = fixed(Float64Array, nPeople);
      const pText = ["name", "photo"];
      const pCols = pText.map(() => fixed(Uint32Array, nPeople));
      // Details only for people that have any (person.detail.at = their row indices, ascending).
      const pDetail = ["knownFor", "birthday", "deathday", "placeOfBirth", "detailsCheckedAt", "biography"];
      const dAt = growable(Int32Array, 1 << 12), dCols = pDetail.map(() => growable(Uint32Array, 1 << 12));
      const D0 = 3 + pText.length;
      await scan(["id", "tmdbPersonId", ...pText, ...pDetail], "people", (r) => {
        const row = pId.length;
        pId.push(r[1]); pTmdb.push(r[2] === null ? NaN : Number(r[2]));
        for (let k = 0; k < pText.length; k++) pCols[k].push(intern(r[k + 3]));
        let any = false;
        for (let k = 0; k < pDetail.length; k++) if (r[D0 + k] !== null) { any = true; break; }
        if (!any) return;
        dAt.push(row);
        for (let k = 0; k < pDetail.length; k++) dCols[k].push(intern(r[D0 + k]));
      });
      const personIds = pId.out();
      counts.people = personIds.length;
      sections["person.id"] = personIds;
      sections["person.tmdbId"] = narrowNum(pTmdb.out());
      pText.forEach((c, k) => { sections[`person.${c}`] = pCols[k].out(); });
      sections["person.detail.at"] = dAt.out();
      pDetail.forEach((c, k) => { sections[`person.detail.${c}`] = dCols[k].out(); });
      counts.peopleWithDetails = (sections["person.detail.at"] as Int32Array).length;
      const personIdx = (id: number) => { let lo = 0, hi = personIds.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; const v = personIds[m]; if (v === id) return m; if (v < id) lo = m + 1; else hi = m - 1; } return -1; };
      stage("people");

      // ── credits: grouped by title key (billing order inside), and by person ──
      const KIND: Record<string, number> = { cast: 1, director: 2, creator: 3, writer: 4 };
      const nCred = await countOf("title_people");
      const keyIndex = new Map<string, number>();
      const keyStrs: string[] = [];
      const cKey = fixed(Int32Array, nCred), cPerson = fixed(Int32Array, nCred), cKind = fixed(Uint8Array, nCred), cRole = fixed(Uint32Array, nCred), cOrder = fixed(Int32Array, nCred);
      await scan(["titleKey", "personId", "kind", "role", "sortOrder"], "title_people", (r) => {
        const p = personIdx(Number(r[2]));
        if (p < 0) return;
        const key = String(r[1]);
        let k = keyIndex.get(key);
        if (k === undefined) { k = keyStrs.length; keyIndex.set(key, k); keyStrs.push(key); }
        cKey.push(k); cPerson.push(p); cKind.push(KIND[r[3]] ?? 0); cRole.push(intern(r[4])); cOrder.push(Number(r[5]) || 0);
      });
      keyIndex.clear();
      const nc = cKey.length;
      const keys = cKey.out(), persons = cPerson.out(), kinds = cKind.out(), roles = cRole.out(), orders = cOrder.out();
      const keyOrder = Int32Array.from(keyStrs.keys()).sort((a, b) => (keyStrs[a] < keyStrs[b] ? -1 : keyStrs[a] > keyStrs[b] ? 1 : 0));
      const keyRank = new Int32Array(keyStrs.length);
      for (let i = 0; i < keyOrder.length; i++) keyRank[keyOrder[i]] = i;
      const keyOff = new Int32Array(keyStrs.length + 1);
      for (let k = 0; k < nc; k++) keyOff[keyRank[keys[k]] + 1]++;
      for (let i = 0; i < keyStrs.length; i++) keyOff[i + 1] += keyOff[i];
      const kcur = keyOff.slice(0, keyStrs.length), byKey = new Int32Array(nc);
      for (let k = 0; k < nc; k++) byKey[kcur[keyRank[keys[k]]]++] = k;
      for (let i = 0; i < keyStrs.length; i++) {
        const seg = byKey.subarray(keyOff[i], keyOff[i + 1]);
        if (seg.length > 1) seg.sort((a, b) => orders[a] - orders[b] || a - b);
      }
      sections["credit.keys"] = Uint32Array.from(keyOrder, (k) => intern(keyStrs[k]));
      keyStrs.length = 0;
      sections["credit.keyOff"] = keyOff;
      // Credits stored in key order, so a key's credits are one contiguous run.
      const credPerson = Int32Array.from(byKey, (k) => persons[k]);
      sections["credit.person"] = credPerson;
      sections["credit.kind"] = Uint8Array.from(byKey, (k) => kinds[k]);
      sections["credit.role"] = Uint32Array.from(byKey, (k) => roles[k]);
      sections["credit.order"] = narrowInt(Int32Array.from(byKey, (k) => orders[k]));
      const pOff = new Int32Array(personIds.length + 1);
      for (let k = 0; k < nc; k++) pOff[credPerson[k] + 1]++;
      for (let i = 0; i < personIds.length; i++) pOff[i + 1] += pOff[i];
      const pcur = pOff.slice(0, personIds.length), pCred = new Int32Array(nc);
      for (let k = 0; k < nc; k++) pCred[pcur[credPerson[k]]++] = k;
      sections["person.creditOff"] = pOff;
      sections["person.credits"] = pCred;
      counts.credits = nc;
      stage("credits");

      // ── IPTV category lists: every portal entry as its cached JSON, in display order ──
      const catType = growable(Uint8Array, 256), catId = growable(Uint32Array, 256), catStart = growable(Int32Array, 256);
      // Shape 0 = an entry that is not a plain object, kept as one JSON value.
      const shapeIndex = new Map<string, number>(), shapeIds: number[] = [0];
      const itemShape = growable(Uint16Array, 1 << 16), itemCopy = growable(Int32Array, 1 << 16);
      const valOff = growable(Int32Array, 1 << 16), vals = growable(Uint32Array, 1 << 20);
      valOff.push(0);
      // Item id (stream_id / series_id as text) per entry, and the title search terms.
      const itemIdPool = growable(Uint32Array, 1 << 16), itemIdStr: string[] = [], itemType: number[] = [];
      const normIds = growable(Uint32Array, 1 << 16), years = growable(Int16Array, 1 << 16);
      const normalize: (s: string) => string = (globalThis as any).__normalizeText;
      const termIndex = new Map<string, number>(), termStrs: string[] = [];
      const pairDoc = growable(Int32Array, 1 << 18), pairTerm = growable(Int32Array, 1 << 18);
      for (const [type, prefix, idField, code] of [["movie", "vod_streams_", "stream_id", 1], ["series", "series_list_", "series_id", 2]] as const) {
        for (const cat of input.genres[type] as string[]) {
          const row = await get("SELECT value FROM xtream_cache WHERE key = ?", [prefix + cat]);
          catType.push(code); catId.push(intern(cat)); catStart.push(itemCopy.length);
          if (!row) continue;
          const text = Buffer.isBuffer(row.value) ? zlib.inflateSync(row.value).toString("utf8") : String(row.value);
          let list: any[];
          try { list = JSON.parse(text); } catch { continue; }
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            if (item === null || typeof item !== "object" || Array.isArray(item)) {
              itemShape.push(0); vals.push(intern(JSON.stringify(item)));
            } else {
              const keys = Object.keys(item);
              const shapeKey = JSON.stringify(keys);
              let sh = shapeIndex.get(shapeKey);
              if (sh === undefined) {
                sh = shapeIds.length;
                if (sh > 0xffff) throw new Error("too many list entry shapes");
                shapeIndex.set(shapeKey, sh); shapeIds.push(intern(shapeKey));
              }
              itemShape.push(sh);
              for (const key of keys) vals.push(intern(JSON.stringify(item[key])));
            }
            valOff.push(vals.length);
            itemCopy.push(idLookup(`${type}_${item?.[idField]}`));
            const doc = itemIdStr.length;
            const idText = String(item?.[idField]);
            itemIdStr.push(idText); itemType.push(code); itemIdPool.push(intern(idText));
            // As SearchIndex: normalized name, its words plus each adjacent pair joined.
            const norm = normalize(String(item?.name ?? ""));
            normIds.push(intern(norm));
            const y = String(item?.year ?? "").slice(0, 4);
            years.push(/^\d{4}$/.test(y) ? Number(y) : 0);
            const words = norm ? norm.split(" ") : [];
            const terms = new Set(words);
            for (let i = 0; i + 1 < words.length; i++) terms.add(words[i] + words[i + 1]);
            for (const t of terms) {
              let ti = termIndex.get(t);
              if (ti === undefined) { ti = termStrs.length; termIndex.set(t, ti); termStrs.push(t); }
              pairDoc.push(doc); pairTerm.push(ti);
            }
          }
        }
      }
      catStart.push(itemCopy.length);
      sections["list.type"] = catType.out();
      sections["list.catId"] = catId.out();
      sections["list.start"] = catStart.out();
      sections["list.shapes"] = Uint32Array.from(shapeIds);
      sections["list.itemShape"] = itemShape.out();
      sections["list.valOff"] = valOff.out();
      sections["list.vals"] = vals.out();
      sections["list.itemCopy"] = itemCopy.out();
      counts.listItems = (sections["list.itemCopy"] as Int32Array).length;
      sections["list.itemId"] = itemIdPool.out();
      // Entries by (type, item id, position): an id's entries are one run, first-listed first.
      sections["list.byItemId"] = Int32Array.from(itemIdStr.keys()).sort((a, b) =>
        itemType[a] - itemType[b] || (itemIdStr[a] < itemIdStr[b] ? -1 : itemIdStr[a] > itemIdStr[b] ? 1 : 0) || a - b);
      itemIdStr.length = 0; itemType.length = 0;

      // Title search: vocabulary sorted (ASCII, so byte order = JS string order), postings CSR.
      sections["search.norm"] = normIds.out();
      sections["search.year"] = years.out();
      const vOrder = Int32Array.from(termStrs.keys()).sort((a, b) => (termStrs[a] < termStrs[b] ? -1 : termStrs[a] > termStrs[b] ? 1 : 0));
      const vRank = new Int32Array(termStrs.length);
      for (let i = 0; i < vOrder.length; i++) vRank[vOrder[i]] = i;
      let vocabBytes = 0;
      for (const t of termStrs) vocabBytes += t.length;
      const vocab = new Uint8Array(vocabBytes), vocabOff = new Int32Array(termStrs.length + 1);
      for (let i = 0, at = 0; i < vOrder.length; i++) {
        const t = termStrs[vOrder[i]];
        vocabOff[i] = at;
        for (let c = 0; c < t.length; c++) vocab[at++] = t.charCodeAt(c);
        vocabOff[i + 1] = at;
      }
      const pd = pairDoc.out(), pt = pairTerm.out();
      const postOff = new Int32Array(termStrs.length + 1);
      for (let k = 0; k < pt.length; k++) postOff[vRank[pt[k]] + 1]++;
      for (let i = 0; i < termStrs.length; i++) postOff[i + 1] += postOff[i];
      const pcur2 = postOff.slice(0, termStrs.length), post = new Int32Array(pt.length);
      for (let k = 0; k < pt.length; k++) post[pcur2[vRank[pt[k]]]++] = pd[k]; // docs ascend: added in order
      // Exact-term lookup for the one-edit typo pass (SearchIndex keeps a Map for it): slots
      // hold vocabulary index + 1, at least twice as many slots as terms.
      let slotsN = 1; while (slotsN < termStrs.length * 2) slotsN <<= 1;
      const termHash = new Int32Array(slotsN), hmask = slotsN - 1;
      for (let i = 0; i < vOrder.length; i++) {
        let h = 2166136261;
        for (let c = vocabOff[i]; c < vocabOff[i + 1]; c++) h = Math.imul(h ^ vocab[c], 16777619);
        let k = (h >>> 0) & hmask;
        while (termHash[k]) k = (k + 1) & hmask;
        termHash[k] = i + 1;
      }
      sections["search.termHash"] = termHash;
      sections["search.vocab"] = vocab;
      sections["search.vocabOff"] = vocabOff;
      sections["search.postOff"] = postOff;
      sections["search.post"] = post;
      counts.searchTerms = termStrs.length;
      termIndex.clear(); termStrs.length = 0;
      copyIdStr.length = 0;
      stage("lists");

      await run("COMMIT");
      const poolStart = new Uint32Array(count + 1);
      poolStart.set(starts.subarray(0, count));
      poolStart[count] = pool.end; // sentinel: where the last text ends
      pool.out().forEach((c, i) => { sections[`pool.chunk.${String(i).padStart(3, "0")}`] = c; });
      sections["pool.start"] = poolStart;
      sections["meta.chunkBits"] = Uint8Array.of(workerData.chunkBits);
      hashes = new Uint32Array(0); starts = new Uint32Array(0); slots = new Int32Array(0);
      counts.strings = count - 1;
      const heapMb = Math.round(require("v8").getHeapStatistics().total_heap_size / 1048576);
      // Checksum of every section in name order (the order the file is written in): computed
      // here so the main thread never hashes the whole snapshot.
      const hash = require("crypto").createHash(workerData.checksum);
      for (const name of Object.keys(sections).sort()) { const v = sections[name]; hash.update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); }
      stage("finish");
      return { version, sections, counts, stages, readMs: Date.now() - started, heapMb, checksum: hash.digest("hex") };
    })().then(
      (out) => conn.close(() => {
        const transfer = [...new Set(Object.values(out.sections).map((v: any) => v.buffer))];
        parentPort.postMessage(out, transfer);
      }),
      (err) => conn.close(() => parentPort.postMessage({ error: String(err?.message || err) })),
    );
  });
}

/** Builds the sections in a worker; the main thread only receives the buffers. */
export function buildSnapshot(input: BuildInput): Promise<BuildOutput> {
  return new Promise((resolve, reject) => {
    // `var __name`: esbuild (tsx, tsup) may wrap named functions in a __name() helper that
    // does not exist inside the eval'd worker.
    // The title normalizer is passed as source too: one implementation for the index and queries.
    const source = `var __name = (f) => f;\nglobalThis.__normalizeText = ${normalizeText.toString()};\n(${workerMain.toString()})();`;
    const worker = new Worker(source, {
      eval: true,
      workerData: { input, sqlite3: require.resolve("sqlite3"), chunkBits: input.chunkBits ?? CHUNK_BITS, checksum: CHECKSUM },
      // Small young generation: many short-lived strings, collected early. Never an old-
      // generation cap (hitting one inside sqlite3 aborts the process, measured).
      resourceLimits: { maxYoungGenerationSizeMb: 8 },
    });
    let done = false;
    worker.once("message", (m: any) => {
      done = true;
      if (m.error) reject(new Error(m.error)); else resolve(m);
    });
    worker.once("error", (e) => { if (!done) { done = true; reject(e); } });
    worker.once("exit", (code) => { if (!done) { done = true; reject(new Error(`snapshot worker exited (${code})`)); } });
  });
}
