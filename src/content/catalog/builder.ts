// Catalog snapshot builder (plan, Phase 1). Runs in a worker thread with its own read-only
// SQLite connection and returns packed sections (typed arrays over transferable buffers).
//
// Layout rules, each measured on the live data before it was chosen:
// - Rows are streamed (`each`), never held as an array of objects; fixed-width columns are
//   allocated once at their exact size from a COUNT(*) first (no doubling, no final copy).
// - Text is stored once however many rows carry it (the same plot on three IPTV copies, the
//   same poster path) in a pool of 8 MB chunks; a row holds a 32-bit pool id. Chunks are never
//   copied or concatenated: the first build that doubled and copied one big buffer peaked at
//   +934 MB. A pooled text is (start, length): start is a global offset whose top bits pick the
//   chunk, length is 16-bit (the longest text is 2.6 KB; a longer one fails the build).
// - Interning uses an open-addressing table of 32-bit slots, not a Map: a Map of 2.2 million
//   strings took most of a 164 MB worker heap and most of the 30 s.
// - IPTV list entries keep their cached JSON text exactly (in chunks, not interned).
// - One read transaction: the snapshot is one consistent moment of the database, and its
//   version is the change-log position read inside that transaction.
// - Values are kept as SQLite returns them (text, numbers, NULL as pool id 0 / NaN); dates
//   become epoch milliseconds. Readers convert; nothing is reinterpreted here.
//
// The worker runs from source text (`eval`) so it needs no separate build entry; it must not
// be terminate()d while sqlite3 holds a connection (that aborts the whole process). It closes
// the connection, posts, and exits by itself.

import { Worker } from "worker_threads";

export interface ColumnSpec { name: string; kind: "text" | "num" | "date" }

export interface BuildInput {
  dbPath: string;
  copyColumns: ColumnSpec[];
  /** Category ids in display order, per type (from readGenres: one source of that order). */
  genres: { movie: string[]; series: string[] };
}

export type Section = Uint8Array | Uint16Array | Int32Array | Uint32Array | Float64Array;

export interface BuildOutput {
  version: number;
  sections: Record<string, Section>;
  counts: Record<string, number>;
  /** Milliseconds per build stage. */
  stages: Record<string, number>;
  readMs: number;
  heapMb: number;
  /** sha256 of the sections in name order, as written to the file. */
  checksum: string;
}

/** Chunk size of pooled text and list entries: 2^23 bytes. */
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

  // Chunked byte store: each piece stays inside one chunk; (start, length) per piece.
  const chunkStore = () => {
    const chunks: Uint8Array[] = [new Uint8Array(CHUNK)];
    let pos = 0;
    return {
      /** Appends bytes[0..n) and returns its global start. */
      add(bytes: Uint8Array, n: number): number {
        if (n > 0xffff) throw new Error(`a text of ${n} bytes is longer than the snapshot allows`);
        if (pos + n > CHUNK) { chunks.push(new Uint8Array(CHUNK)); pos = 0; }
        const c = chunks.length - 1;
        chunks[c].set(bytes.subarray(0, n), pos);
        const start = c * CHUNK + pos;
        pos += n;
        return start;
      },
      byte(start: number, i: number) { return chunks[Math.floor(start / CHUNK)][(start % CHUNK) + i]; },
      /** The chunks; the last one trimmed to what is used. */
      out() { const last = chunks.length - 1; chunks[last] = chunks[last].slice(0, pos); return chunks.splice(0); },
    };
  };

  // ── string pool with an open-addressing intern table ──────────────────────────
  // id 0 = NULL. Per id: hash, global start, byte length. `slots` holds ids (0 = empty),
  // probed linearly; it doubles when half full.
  const pool = chunkStore();
  let cap = 1 << 20, count = 1;
  let hashes = new Uint32Array(cap), starts = new Uint32Array(cap), lens = new Uint16Array(cap);
  let slots = new Int32Array(1 << 21), mask = slots.length - 1;
  let scratch = new Uint8Array(1 << 16);
  const fnv = (b: Uint8Array, n: number) => { let h = 2166136261; for (let i = 0; i < n; i++) h = Math.imul(h ^ b[i], 16777619); return h >>> 0; };
  const ensureCap = () => {
    if (count < cap) return;
    cap = Math.ceil(cap * 1.5);
    const h = new Uint32Array(cap); h.set(hashes); hashes = h;
    const st = new Uint32Array(cap); st.set(starts); starts = st;
    const l = new Uint16Array(cap); l.set(lens); lens = l;
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
    if (lens[id] !== n) return false;
    const st = starts[id];
    for (let i = 0; i < n; i++) if (pool.byte(st, i) !== b[i]) return false;
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
    hashes[id] = h; starts[id] = pool.add(scratch, n); lens[id] = n;
    slots[k] = id;
    if (count * 2 > slots.length) rehash();
    return id;
  };

  const conn = new sqlite3.Database(input.dbPath, sqlite3.OPEN_READONLY, (openErr: any) => {
    if (openErr) { parentPort.postMessage({ error: String(openErr.message || openErr) }); return; }
    conn.configure("busyTimeout", 5000);
    const all = (sql: string, params: any[] = []) => new Promise<any[]>((resolve, reject) => conn.all(sql, params, (err: any, rows: any[]) => (err ? reject(err) : resolve(rows))));
    const get = (sql: string, params: any[] = []) => new Promise<any>((resolve, reject) => conn.get(sql, params, (err: any, r: any) => (err ? reject(err) : resolve(r))));
    // Pages of PAGE rows in rowid (storage) order, inside the one read transaction. Not
    // `each`: sqlite3 fetches rows faster than they are packed and queues them in native
    // memory (measured: +863 MB peak with a 32 MB worker heap). A page bounds that queue.
    const PAGE = 4000;
    const scan = async (columns: string, table: string, onRow: (r: any) => void) => {
      let after = -Infinity;
      for (;;) {
        const rows = await all(`SELECT rowid AS _rid, ${columns} FROM \`${table}\` WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`, [after === -Infinity ? -9007199254740991 : after]);
        for (const r of rows) onRow(r);
        if (rows.length < PAGE) return;
        after = rows[rows.length - 1]._rid;
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
      await scan(cols.map((c) => `\`${c.name}\``).join(", "), "content_meta", (r) => {
        const i = copyIdStr.length;
        if (i >= nCopies) throw new Error("content_meta changed size during the build");
        copyIdStr.push(String(r.id));
        typeCode[i] = r.type === "series" ? 2 : 1;
        for (let k = 0; k < cols.length; k++) {
          const v = r[cols[k].name];
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
        await scan("contentId, value", table, (r) => {
          const c = idLookup(String(r.contentId));
          if (c < 0) return; // orphan tag (the integrity job removes these)
          let v = dict.get(String(r.value));
          if (v === undefined) { v = dictIds.length; dict.set(String(r.value), v); dictIds.push(intern(r.value)); }
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
      const pText = ["name", "photo", "knownFor", "birthday", "deathday", "placeOfBirth", "detailsCheckedAt", "biography"];
      const pCols = pText.map(() => fixed(Uint32Array, nPeople));
      await scan(`id, tmdbPersonId, ${pText.join(", ")}`, "people", (r) => {
        pId.push(r.id); pTmdb.push(r.tmdbPersonId === null ? NaN : Number(r.tmdbPersonId));
        for (let k = 0; k < pText.length; k++) pCols[k].push(intern(r[pText[k]]));
      });
      const personIds = pId.out();
      counts.people = personIds.length;
      sections["person.id"] = personIds;
      sections["person.tmdbId"] = pTmdb.out();
      pText.forEach((c, k) => { sections[`person.${c}`] = pCols[k].out(); });
      const personIdx = (id: number) => { let lo = 0, hi = personIds.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; const v = personIds[m]; if (v === id) return m; if (v < id) lo = m + 1; else hi = m - 1; } return -1; };
      stage("people");

      // ── credits: grouped by title key (billing order inside), and by person ──
      const KIND: Record<string, number> = { cast: 1, director: 2, creator: 3, writer: 4 };
      const nCred = await countOf("title_people");
      const keyIndex = new Map<string, number>();
      const keyStrs: string[] = [];
      const cKey = fixed(Int32Array, nCred), cPerson = fixed(Int32Array, nCred), cKind = fixed(Uint8Array, nCred), cRole = fixed(Uint32Array, nCred), cOrder = fixed(Int32Array, nCred);
      await scan("titleKey, personId, kind, role, sortOrder", "title_people", (r) => {
        const p = personIdx(Number(r.personId));
        if (p < 0) return;
        let k = keyIndex.get(r.titleKey);
        if (k === undefined) { k = keyStrs.length; keyIndex.set(r.titleKey, k); keyStrs.push(r.titleKey); }
        cKey.push(k); cPerson.push(p); cKind.push(KIND[r.kind] ?? 0); cRole.push(intern(r.role)); cOrder.push(Number(r.sortOrder) || 0);
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
      sections["credit.order"] = Int32Array.from(byKey, (k) => orders[k]);
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
      const items = chunkStore();
      const itemStart = growable(Uint32Array, 1 << 16), itemLen = growable(Uint16Array, 1 << 16), itemCopy = growable(Int32Array, 1 << 16);
      let itemBytes = new Uint8Array(1 << 14);
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
            const json = JSON.stringify(item);
            if (itemBytes.length < json.length * 3) itemBytes = new Uint8Array(json.length * 3 + 16);
            const n = enc.encodeInto(json, itemBytes).written;
            itemStart.push(items.add(itemBytes, n)); itemLen.push(n);
            itemCopy.push(idLookup(`${type}_${item?.[idField]}`));
          }
        }
      }
      catStart.push(itemCopy.length);
      sections["list.type"] = catType.out();
      sections["list.catId"] = catId.out();
      sections["list.start"] = catStart.out();
      items.out().forEach((c, i) => { sections[`list.chunk.${String(i).padStart(3, "0")}`] = c; });
      sections["list.itemStart"] = itemStart.out();
      sections["list.itemLen"] = itemLen.out();
      sections["list.itemCopy"] = itemCopy.out();
      counts.listItems = (sections["list.itemCopy"] as Int32Array).length;
      copyIdStr.length = 0;
      stage("lists");

      await run("COMMIT");
      pool.out().forEach((c, i) => { sections[`pool.chunk.${String(i).padStart(3, "0")}`] = c; });
      sections["pool.start"] = starts.slice(0, count);
      sections["pool.len"] = lens.slice(0, count);
      hashes = new Uint32Array(0); starts = new Uint32Array(0); lens = new Uint16Array(0); slots = new Int32Array(0);
      counts.strings = count - 1;
      const heapMb = Math.round(require("v8").getHeapStatistics().total_heap_size / 1048576);
      // Checksum of every section in name order (the order the file is written in): computed
      // here so the main thread never hashes the whole snapshot.
      const hash = require("crypto").createHash("sha256");
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
    const source = `var __name = (f) => f;\n(${workerMain.toString()})();`;
    const worker = new Worker(source, {
      eval: true,
      workerData: { input, sqlite3: require.resolve("sqlite3"), chunkBits: CHUNK_BITS },
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
