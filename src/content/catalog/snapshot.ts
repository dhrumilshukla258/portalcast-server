// Read side of the catalog snapshot: typed-array views and the lookups the routes will use
// (plan, Phase 1b). Nothing here allocates per row except the values a caller asks for.

import { INT_NULL, type Section } from "./builder";

export type TagKind = "genre" | "country" | "theme";
const PERSON_DETAILS = ["knownFor", "birthday", "deathday", "placeOfBirth", "detailsCheckedAt", "biography"] as const;

/** chunk[p..] starts with q. */
function bytesAt(chunk: Uint8Array, p: number, q: Uint8Array): boolean {
  for (let j = 0; j < q.length; j++) if (chunk[p + j] !== q[j]) return false;
  return true;
}

export interface CreditRow { person: number; kind: string; role: string | null; order: number }

/** A number column value: NaN (Float64Array) or INT_NULL (Int32Array) is NULL. */
const numAt = (col: Section, i: number): number | null => {
  const v = col[i];
  if (col instanceof Int32Array) return v === INT_NULL ? null : v;
  return Number.isNaN(v) ? null : v;
};

export class CatalogSnapshot {
  // ignoreBOM: keep a leading U+FEFF (some plots start with one; the default decoder drops it).
  private readonly dec = new TextDecoder("utf-8", { ignoreBOM: true });
  private readonly chunk: number;
  private readonly poolChunks: Uint8Array[];
  private readonly poolStart: Uint32Array;
  // Title search arrays, kept as fields: the search loop touches them per posting.
  private readonly vocab: Uint8Array;
  private readonly vocabOff: Int32Array;
  readonly post: Int32Array;
  readonly postOff: Int32Array;
  private readonly normIds: Uint32Array;
  private readonly termHash: Int32Array;
  /** Per list-entry shape: `"key":` prefixes, decoded on first use (four shapes on live data). */
  private readonly shapeKeys: (string[] | undefined)[] = [];
  readonly copyCount: number;
  readonly personCount: number;

  constructor(
    readonly version: number,
    readonly builtAt: string,
    readonly counts: Record<string, number>,
    private readonly s: Record<string, Section>,
  ) {
    this.chunk = 2 ** (s["meta.chunkBits"] as Uint8Array)[0];
    this.poolChunks = Object.keys(s).filter((k) => k.startsWith("pool.chunk.")).sort().map((k) => s[k] as Uint8Array);
    this.poolStart = s["pool.start"] as Uint32Array;
    this.vocab = s["search.vocab"] as Uint8Array;
    this.vocabOff = s["search.vocabOff"] as Int32Array;
    this.post = s["search.post"] as Int32Array;
    this.postOff = s["search.postOff"] as Int32Array;
    this.normIds = s["search.norm"] as Uint32Array;
    this.termHash = s["search.termHash"] as Int32Array;
    this.copyCount = (s["copy.byId"] as Int32Array).length;
    this.personCount = (s["person.id"] as Int32Array).length;
  }

  /** A section by name (read only), for readers that keep their own layout (people search). */
  section(name: string): Section {
    return this.col(name);
  }

  /** Total bytes held by the sections. */
  get bytes(): number {
    let n = 0;
    for (const v of Object.values(this.s)) n += v.byteLength;
    return n;
  }

  /** A pooled text by id; null for id 0. Texts lie back to back and chunks are stored trimmed,
   *  so a text ends where the next one starts; when the next one opened a new chunk, subarray
   *  stops at this chunk's end. */
  str(id: number): string | null {
    if (!id) return null;
    const st = this.poolStart[id], c = Math.floor(st / this.chunk), base = c * this.chunk;
    return this.dec.decode(this.poolChunks[c].subarray(st - base, this.poolStart[id + 1] - base));
  }

  private col(name: string): Section {
    const c = this.s[name];
    if (!c) throw new Error(`snapshot has no section ${name}`);
    return c;
  }

  /** A text column of a copy (content_meta row), as stored. */
  copyText(column: string, i: number): string | null {
    return this.str((this.col(`copy.${column}`) as Uint32Array)[i]);
  }

  /** A numeric column of a copy; null when NULL. */
  copyNum(column: string, i: number): number | null {
    return numAt(this.col(`copy.${column}`), i);
  }

  /** Copy index of a content id ("movie_123", "series_L4"), or -1. Binary search, no map. */
  copyIndex(id: string): number {
    const byId = this.s["copy.byId"] as Int32Array;
    const ids = this.s["copy.id"] as Uint32Array;
    let lo = 0, hi = byId.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const v = this.str(ids[byId[m]])!;
      if (v === id) return byId[m];
      if (v < id) lo = m + 1; else hi = m - 1;
    }
    return -1;
  }

  /** Copies with this type and TMDB id (versions of one title across categories). */
  copiesByTmdb(type: "movie" | "series", tmdbId: number): number[] {
    const order = this.s["copy.byTmdb"] as Int32Array;
    const code = this.s["copy.typeCode"] as Uint8Array;
    const tmdb = this.s["copy.tmdbId"]; // only copies with a TMDB id are in byTmdb
    const want = type === "series" ? 2 : 1;
    const cmp = (i: number) => code[i] - want || tmdb[i] - tmdbId;
    let lo = 0, hi = order.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cmp(order[m]) < 0) lo = m + 1; else hi = m; }
    const out: number[] = [];
    for (let k = lo; k < order.length && cmp(order[k]) === 0; k++) out.push(order[k]);
    return out;
  }

  /** A copy's tags of one kind, in stored order. */
  tagsOf(kind: TagKind, copy: number): string[] {
    const off = this.s[`tag.${kind}.copyOff`] as Int32Array;
    const vals = this.s[`tag.${kind}.copyVals`] as Int32Array;
    const dict = this.s[`tag.${kind}.dict`] as Uint32Array;
    const out: string[] = [];
    for (let k = off[copy]; k < off[copy + 1]; k++) out.push(this.str(dict[vals[k]])!);
    return out;
  }

  /** Copies carrying a tag value, ascending (a view, not a copy). */
  copiesWithTag(kind: TagKind, value: string): Int32Array {
    const dict = this.s[`tag.${kind}.dict`] as Uint32Array;
    const off = this.s[`tag.${kind}.valOff`] as Int32Array;
    const copies = this.s[`tag.${kind}.valCopies`] as Int32Array;
    for (let v = 0; v < dict.length; v++) if (this.str(dict[v]) === value) return copies.subarray(off[v], off[v + 1]);
    return copies.subarray(0, 0);
  }

  /** Credits of a title key ("movie:603", or a content id), in billing order. */
  creditsOf(titleKey: string): CreditRow[] {
    const keys = this.s["credit.keys"] as Uint32Array;
    const keyOff = this.s["credit.keyOff"] as Int32Array;
    let lo = 0, hi = keys.length - 1, at = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const v = this.str(keys[m])!;
      if (v === titleKey) { at = m; break; }
      if (v < titleKey) lo = m + 1; else hi = m - 1;
    }
    if (at < 0) return [];
    const person = this.s["credit.person"] as Int32Array, kind = this.s["credit.kind"] as Uint8Array;
    const role = this.s["credit.role"] as Uint32Array, order = this.s["credit.order"], kinds = this.s["credit.kindDict"] as Uint32Array;
    const out: CreditRow[] = [];
    for (let k = keyOff[at]; k < keyOff[at + 1]; k++) {
      out.push({ person: person[k], kind: this.str(kinds[kind[k]]) ?? "", role: this.str(role[k]), order: order[k] });
    }
    return out;
  }

  /** Copies sharing copy i's groupKey (every version of the title), in copy order; [i] when
   *  it has none. */
  groupOf(i: number): number[] {
    const col = this.s["copy.groupKey"] as Uint32Array, order = this.s["copy.byGroup"] as Int32Array;
    const g = col[i];
    if (!g) return [i];
    let lo = 0, hi = order.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (col[order[m]] < g) lo = m + 1; else hi = m; }
    const out: number[] = [];
    for (let k = lo; k < order.length && col[order[k]] === g; k++) out.push(order[k]);
    return out;
  }

  /** Person row index of a people.id, or -1. */
  personIndex(id: number): number {
    const ids = this.s["person.id"] as Int32Array;
    let lo = 0, hi = ids.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ids[m] === id) return m; if (ids[m] < id) lo = m + 1; else hi = m - 1; }
    return -1;
  }

  person(i: number) {
    const at = this.s["person.detail.at"] as Int32Array;
    let lo = 0, hi = at.length - 1, d = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (at[m] === i) { d = m; break; } if (at[m] < i) lo = m + 1; else hi = m - 1; }
    const detail = (c: (typeof PERSON_DETAILS)[number]) => (d < 0 ? null : this.str((this.s[`person.detail.${c}`] as Uint32Array)[d]));
    return {
      id: (this.s["person.id"] as Int32Array)[i],
      tmdbPersonId: numAt(this.s["person.tmdbId"], i),
      name: this.str((this.s["person.name"] as Uint32Array)[i]) ?? "",
      photo: this.str((this.s["person.photo"] as Uint32Array)[i]),
      knownFor: detail("knownFor"),
      birthday: detail("birthday"),
      deathday: detail("deathday"),
      placeOfBirth: detail("placeOfBirth"),
      detailsCheckedAt: detail("detailsCheckedAt"),
      biography: detail("biography"),
    };
  }

  /** Title keys a person is credited on (with kind and role), in stored order. */
  personCredits(i: number): { titleKey: string; kind: string; role: string | null; order: number }[] {
    const off = this.s["person.creditOff"] as Int32Array, list = this.s["person.credits"] as Int32Array;
    const keys = this.s["credit.keys"] as Uint32Array, keyOff = this.s["credit.keyOff"] as Int32Array;
    // The key of credit c: the last key whose run starts at or before c (binary search).
    const keyOf = (c: number) => { let lo = 0, hi = keys.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (keyOff[m] <= c) lo = m; else hi = m - 1; } return lo; };
    const kind = this.s["credit.kind"] as Uint8Array, role = this.s["credit.role"] as Uint32Array, order = this.s["credit.order"];
    const kinds = this.s["credit.kindDict"] as Uint32Array;
    const out = [];
    for (let k = off[i]; k < off[i + 1]; k++) {
      const c = list[k];
      out.push({ titleKey: this.str(keys[keyOf(c)])!, kind: this.str(kinds[kind[c]]) ?? "", role: this.str(role[c]), order: order[c] });
    }
    return out;
  }

  /** The IPTV categories of a type, in display order, with their item ranges. */
  categories(type: "movie" | "series"): { id: string; start: number; end: number }[] {
    const t = this.s["list.type"] as Uint8Array, ids = this.s["list.catId"] as Uint32Array, start = this.s["list.start"] as Int32Array;
    const want = type === "series" ? 2 : 1;
    const out = [];
    for (let c = 0; c < t.length; c++) if (t[c] === want) out.push({ id: this.str(ids[c])!, start: start[c], end: start[c + 1] });
    return out;
  }

  private keysOfShape(sh: number): string[] {
    let keys = this.shapeKeys[sh];
    if (!keys) {
      keys = (JSON.parse(this.str((this.s["list.shapes"] as Uint32Array)[sh])!) as string[]).map((k) => `${JSON.stringify(k)}:`);
      this.shapeKeys[sh] = keys;
    }
    return keys;
  }

  /** A portal list entry exactly as cached (rebuilt from its shape and pooled values). */
  listItem(k: number): any {
    return JSON.parse(this.listItemJson(k));
  }

  /** The entry's JSON text: equal to JSON.stringify of the cached entry (same keys, same order). */
  listItemJson(k: number): string {
    const sh = (this.s["list.itemShape"] as Uint16Array)[k];
    const off = this.s["list.valOff"] as Int32Array, vals = this.s["list.vals"] as Uint32Array;
    if (sh === 0) return this.str(vals[off[k]])!;
    const keys = this.keysOfShape(sh);
    let json = "{";
    for (let j = 0, v = off[k]; v < off[k + 1]; j++, v++) json += (j ? "," : "") + keys[j] + this.str(vals[v]);
    return `${json}}`;
  }

  /** Number of list entries (both types). */
  get listEntryCount(): number {
    return (this.s["list.itemCopy"] as Int32Array).length;
  }

  /** One field of a portal list entry (undefined when the entry has no such key), without
   *  rebuilding the whole entry. */
  listField(k: number, key: string): any {
    const sh = (this.s["list.itemShape"] as Uint16Array)[k];
    if (sh === 0) return this.listItem(k)?.[key];
    const j = this.keysOfShape(sh).indexOf(`${JSON.stringify(key)}:`);
    if (j < 0) return undefined;
    return JSON.parse(this.str((this.s["list.vals"] as Uint32Array)[(this.s["list.valOff"] as Int32Array)[k] + j])!);
  }

  /** The copy (content_meta row) of a list entry, or -1 when it has none yet. */
  listItemCopy(k: number): number {
    return (this.s["list.itemCopy"] as Int32Array)[k];
  }

  /** Number of category lists (both types, in the order they were built). */
  get listCategoryCount(): number {
    return (this.s["list.type"] as Uint8Array).length;
  }

  /** Category list c: its type, category id and entry range. */
  listCategory(c: number): { type: "movie" | "series"; id: string; start: number; end: number } {
    const start = this.s["list.start"] as Int32Array;
    return {
      type: (this.s["list.type"] as Uint8Array)[c] === 2 ? "series" : "movie",
      id: this.str((this.s["list.catId"] as Uint32Array)[c])!,
      start: start[c], end: start[c + 1],
    };
  }

  /** The category list (index) holding entry k. */
  listCategoryOf(k: number): number {
    const start = this.s["list.start"] as Int32Array;
    let lo = 0, hi = start.length - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (start[m] <= k) lo = m; else hi = m - 1; }
    return lo;
  }

  /** An entry's item id (stream_id / series_id) as text, as String(item.stream_id) gives it. */
  listItemId(k: number): string {
    return this.str((this.s["list.itemId"] as Uint32Array)[k])!;
  }

  /** Entries of this type carrying this item id, in list order. */
  listEntriesWithId(type: "movie" | "series", id: string): number[] {
    const order = this.s["list.byItemId"] as Int32Array;
    const t = this.s["list.type"] as Uint8Array;
    const want = type === "series" ? 2 : 1;
    const cmp = (k: number) => {
      const tk = t[this.listCategoryOf(k)];
      if (tk !== want) return tk - want;
      const v = this.listItemId(k);
      return v < id ? -1 : v > id ? 1 : 0;
    };
    let lo = 0, hi = order.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cmp(order[m]) < 0) lo = m + 1; else hi = m; }
    const out: number[] = [];
    for (let i = lo; i < order.length && cmp(order[i]) === 0; i++) out.push(order[i]);
    return out;
  }

  // ── title search (layout: builder.ts; algorithm: catalog/views.ts, as searchIndex.ts) ──

  /** Byte comparison of vocabulary term i with q (ASCII: orders like JS strings). */
  private cmpTerm(i: number, q: Uint8Array): number {
    const vocab = this.vocab, a = this.vocabOff[i], len = this.vocabOff[i + 1] - a, n = Math.min(len, q.length);
    for (let j = 0; j < n; j++) { const d = vocab[a + j] - q[j]; if (d !== 0) return d; }
    return len - q.length;
  }

  private termHasPrefix(i: number, q: Uint8Array): boolean {
    const vocab = this.vocab, a = this.vocabOff[i];
    if (this.vocabOff[i + 1] - a < q.length) return false;
    for (let j = 0; j < q.length; j++) if (vocab[a + j] !== q[j]) return false;
    return true;
  }

  /** [lo, hi) of the vocabulary terms starting with q. */
  termPrefixRange(q: Uint8Array): [number, number] {
    const count = this.vocabOff.length - 1;
    let lo = 0, hi = count;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.cmpTerm(m, q) < 0) lo = m + 1; else hi = m; }
    let a = lo, b = count;
    while (a < b) { const m = (a + b) >> 1; if (this.termHasPrefix(m, q)) a = m + 1; else b = m; }
    return [lo, a];
  }

  /** Vocabulary index of exactly `term` (ASCII), or -1: one hash probe, no allocation. */
  termIndex(term: string): number {
    let h = 2166136261;
    for (let j = 0; j < term.length; j++) h = Math.imul(h ^ term.charCodeAt(j), 16777619);
    const slots = this.termHash, mask = slots.length - 1, vocab = this.vocab;
    for (let k = (h >>> 0) & mask; ; k = (k + 1) & mask) {
      const v = slots[k];
      if (!v) return -1;
      const a = this.vocabOff[v - 1];
      if (this.vocabOff[v] - a !== term.length) continue;
      let j = 0;
      while (j < term.length && vocab[a + j] === term.charCodeAt(j)) j++;
      if (j === term.length) return v - 1;
    }
  }

  termLength(i: number): number {
    return this.vocabOff[i + 1] - this.vocabOff[i];
  }

  /** List entries whose title has term i, ascending (a view). */
  termEntries(i: number): Int32Array {
    return this.post.subarray(this.postOff[i], this.postOff[i + 1]);
  }

  /** An entry's normalized title (normalizeText of its name). */
  searchNorm(k: number): string {
    return this.str(this.normIds[k]) ?? "";
  }

  /**
   * How an entry's normalized title relates to the query, compared as bytes in the pool (ASCII,
   * never decoded): relation | length << 2, where relation 3 = equal to `a` or `b`, 2 = starts
   * with `b`, 1 = contains `b`, 0 = none (SearchIndex's ranking tests), and length is the title's.
   */
  searchNormRelation(k: number, a: Uint8Array, b: Uint8Array): number {
    const id = this.normIds[k];
    if (!id) return 0;
    const st = this.poolStart[id], c = Math.floor(st / this.chunk), base = c * this.chunk, chunk = this.poolChunks[c];
    const from = st - base, to = Math.min(this.poolStart[id + 1] - base, chunk.length), len = to - from;
    if ((len === a.length && bytesAt(chunk, from, a)) || (len === b.length && bytesAt(chunk, from, b))) return 3 | (len << 2);
    if (len < b.length) return len << 2;
    if (bytesAt(chunk, from, b)) return 2 | (len << 2);
    for (let p = from + 1; p + b.length <= to; p++) if (chunk[p] === b[0] && bytesAt(chunk, p, b)) return 1 | (len << 2);
    return len << 2;
  }

  /** An entry's year when its first four characters are digits, else 0. */
  searchYear(k: number): number {
    return (this.s["search.year"] as Int16Array)[k];
  }
}
