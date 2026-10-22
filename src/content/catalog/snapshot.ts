// Read side of the catalog snapshot: typed-array views and the lookups the routes will use
// (plan, Phase 1b). Nothing here allocates per row except the values a caller asks for.

import { INT_NULL, type Section } from "./builder";

export type TagKind = "genre" | "country" | "theme";
export const CREDIT_KINDS = ["", "cast", "director", "creator", "writer"] as const;
const PERSON_DETAILS = ["knownFor", "birthday", "deathday", "placeOfBirth", "detailsCheckedAt", "biography"] as const;

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
    this.copyCount = (s["copy.byId"] as Int32Array).length;
    this.personCount = (s["person.id"] as Int32Array).length;
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
    const role = this.s["credit.role"] as Uint32Array, order = this.s["credit.order"];
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

  /** Title keys a person is credited on (with kind and role), in key order. */
  personCredits(i: number): { titleKey: string; kind: string; role: string | null; order: number }[] {
    const off = this.s["person.creditOff"] as Int32Array, list = this.s["person.credits"] as Int32Array;
    const keys = this.s["credit.keys"] as Uint32Array, keyOff = this.s["credit.keyOff"] as Int32Array;
    // The key of credit c: the last key whose run starts at or before c (binary search).
    const keyOf = (c: number) => { let lo = 0, hi = keys.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (keyOff[m] <= c) lo = m; else hi = m - 1; } return lo; };
    const kind = this.s["credit.kind"] as Uint8Array, role = this.s["credit.role"] as Uint32Array, order = this.s["credit.order"];
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
    const sh = (this.s["list.itemShape"] as Uint16Array)[k];
    const off = this.s["list.valOff"] as Int32Array, vals = this.s["list.vals"] as Uint32Array;
    if (sh === 0) return JSON.parse(this.str(vals[off[k]])!);
    const keys = this.keysOfShape(sh);
    let json = "{";
    for (let j = 0, v = off[k]; v < off[k + 1]; j++, v++) json += (j ? "," : "") + keys[j] + this.str(vals[v]);
    return JSON.parse(`${json}}`);
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
}
