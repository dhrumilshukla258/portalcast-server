// Read side of the catalog snapshot: typed-array views and the lookups the routes will use
// (plan, Phase 1b). Nothing here allocates per row except the values a caller asks for.

import { CHUNK_BITS, type Section } from "./builder";

const CHUNK = 2 ** CHUNK_BITS;

export type TagKind = "genre" | "country" | "theme";
export const CREDIT_KINDS = ["", "cast", "director", "creator", "writer"] as const;

export interface CreditRow { person: number; kind: string; role: string | null; order: number }

export class CatalogSnapshot {
  // ignoreBOM: keep a leading U+FEFF (some plots start with one; the default decoder drops it).
  private readonly dec = new TextDecoder("utf-8", { ignoreBOM: true });
  private readonly poolChunks: Uint8Array[];
  private readonly poolStart: Uint32Array;
  private readonly poolLen: Uint16Array;
  private readonly listChunks: Uint8Array[];
  readonly copyCount: number;
  readonly personCount: number;

  constructor(
    readonly version: number,
    readonly builtAt: string,
    readonly counts: Record<string, number>,
    private readonly s: Record<string, Section>,
  ) {
    const chunks = (prefix: string) => Object.keys(s).filter((k) => k.startsWith(prefix)).sort().map((k) => s[k] as Uint8Array);
    this.poolChunks = chunks("pool.chunk.");
    this.poolStart = s["pool.start"] as Uint32Array;
    this.poolLen = s["pool.len"] as Uint16Array;
    this.listChunks = chunks("list.chunk.");
    this.copyCount = (s["copy.byId"] as Int32Array).length;
    this.personCount = (s["person.id"] as Int32Array).length;
  }

  /** Total bytes held by the sections. */
  get bytes(): number {
    let n = 0;
    for (const v of Object.values(this.s)) n += v.byteLength;
    return n;
  }

  /** A pooled text by id; null for id 0. Each text lies inside one chunk. */
  str(id: number): string | null {
    if (!id) return null;
    const st = this.poolStart[id];
    const local = st % CHUNK;
    return this.dec.decode(this.poolChunks[Math.floor(st / CHUNK)].subarray(local, local + this.poolLen[id]));
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
    const v = (this.col(`copy.${column}`) as Float64Array)[i];
    return Number.isNaN(v) ? null : v;
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
    const tmdb = this.s["copy.tmdbId"] as Float64Array;
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
    const role = this.s["credit.role"] as Uint32Array, order = this.s["credit.order"] as Int32Array;
    const out: CreditRow[] = [];
    for (let k = keyOff[at]; k < keyOff[at + 1]; k++) {
      out.push({ person: person[k], kind: CREDIT_KINDS[kind[k]] ?? "", role: this.str(role[k]), order: order[k] });
    }
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
    const t = (c: string) => this.str((this.s[`person.${c}`] as Uint32Array)[i]);
    const tmdb = (this.s["person.tmdbId"] as Float64Array)[i];
    return {
      id: (this.s["person.id"] as Int32Array)[i],
      tmdbPersonId: Number.isNaN(tmdb) ? null : tmdb,
      name: t("name") ?? "",
      photo: t("photo"),
      knownFor: t("knownFor"),
      birthday: t("birthday"),
      deathday: t("deathday"),
      placeOfBirth: t("placeOfBirth"),
      detailsCheckedAt: t("detailsCheckedAt"),
      biography: t("biography"),
    };
  }

  /** Title keys a person is credited on (with kind and role), in key order. */
  personCredits(i: number): { titleKey: string; kind: string; role: string | null; order: number }[] {
    const off = this.s["person.creditOff"] as Int32Array, list = this.s["person.credits"] as Int32Array;
    const keys = this.s["credit.keys"] as Uint32Array, keyOff = this.s["credit.keyOff"] as Int32Array;
    // The key of credit c: the last key whose run starts at or before c (binary search).
    const keyOf = (c: number) => { let lo = 0, hi = keys.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (keyOff[m] <= c) lo = m; else hi = m - 1; } return lo; };
    const kind = this.s["credit.kind"] as Uint8Array, role = this.s["credit.role"] as Uint32Array, order = this.s["credit.order"] as Int32Array;
    const out = [];
    for (let k = off[i]; k < off[i + 1]; k++) {
      const c = list[k];
      out.push({ titleKey: this.str(keys[keyOf(c)])!, kind: CREDIT_KINDS[kind[c]] ?? "", role: this.str(role[c]), order: order[c] });
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

  /** A portal list entry exactly as cached (parsed on demand: only a page's worth at a time). */
  listItem(k: number): any {
    const st = (this.s["list.itemStart"] as Uint32Array)[k], n = (this.s["list.itemLen"] as Uint16Array)[k];
    const local = st % CHUNK;
    return JSON.parse(this.dec.decode(this.listChunks[Math.floor(st / CHUNK)].subarray(local, local + n)));
  }

  /** The copy (content_meta row) of a list entry, or -1 when it has none yet. */
  listItemCopy(k: number): number {
    return (this.s["list.itemCopy"] as Int32Array)[k];
  }
}
