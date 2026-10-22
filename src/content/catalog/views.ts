// "All Movies" / "All Series" (category="*") over the catalog snapshot (plan, Phase 1b). Same
// answers as content/catalogUnion.ts, without holding the ~132k parsed portal entries (186 MB of
// heap on the working copy): a view is an index array over snapshot list entries.
//
// A view per (profile, type) holds:
//   raw     positions 0..N-1 = the visible categories' lists concatenated in genre order. A
//           position refers to a snapshot entry (ref >= 0) or to an entry of a list read from the
//           cache because it changed after the snapshot was built (ref < 0, see "Changed lists").
//   browse  raw with content-manager overrides applied, by the same rules as
//           applyOverridesToUnion (hidden and moved-out dropped, renames, moved-in appended,
//           sort_order), as positions plus renames; entries are rebuilt only for the page shown.
//   search  ranked title search over raw, the algorithm of content/searchIndex.ts (same
//           normalizer, terms, typo rule, scores and tie order) on the snapshot's packed index.
//
// Changed lists: each visible list key is checked per request against the cache version the
// snapshot holds (O(visible categories), as catalogUnion's fingerprint was). A list written
// since is read once: when it equals the snapshot's (the daily refresh mostly rewrites lists
// unchanged) it is marked current again; otherwise it is kept, parsed, until the next rebuild.

import { readGenres } from "@/infra/storage";
import { xtreamCache, xtreamCacheKeyVersion } from "@/services/xtreamCache";
import { contentKey, getHiddenGenreIds, overridesGeneration, getAllContentOverrides } from "@/content/overrides";
import { normalizeText, editsOne, STOP_WORDS, MIN_FUZZY_LEN } from "@/content/searchIndex";
import type { CatalogSnapshot } from "./snapshot";
import { catalogSnapshot, listMatchesSnapshot, markListMatches } from "./store";

export type CatalogType = "movie" | "series";

const PREFIX: Record<CatalogType, string> = { movie: "vod_streams_", series: "series_list_" };
const ID_FIELD: Record<CatalogType, string> = { movie: "stream_id", series: "series_id" };
const listKey = (type: CatalogType, genreId: string) => PREFIX[type] + genreId;
const itemIdOf = (type: CatalogType, item: any): string => String(item?.[ID_FIELD[type]]);
/** Override key exactly as applyPortalItemOverrides computes it (contentKey of parseInt(id)). */
const overrideKeyOfId = (type: CatalogType, id: string): string => contentKey(type, String(parseInt(id)));

/** A page source: what the routes slice. */
export interface PagedList {
  readonly length: number;
  page(offset: number, count: number): any[];
}

// ── changed lists ──────────────────────────────────────────────────────────────

interface ChangedList { snap: CatalogSnapshot; version: string; list: any[] | null }
const changed = new Map<string, ChangedList>();
const checking = new Map<string, Promise<ChangedList | null>>();
const categoryIndex = new WeakMap<CatalogSnapshot, Map<string, number>>();

function snapshotCategory(snap: CatalogSnapshot, key: string): number {
  let index = categoryIndex.get(snap);
  if (!index) {
    index = new Map();
    for (let c = 0; c < snap.listCategoryCount; c++) {
      const cat = snap.listCategory(c);
      const k = listKey(cat.type, cat.id);
      if (!index.has(k)) index.set(k, c);
    }
    categoryIndex.set(snap, index);
  }
  return index.get(key) ?? -1;
}

/** Equal to the snapshot's list, entry for entry (the snapshot rebuilds JSON.stringify exactly). */
function sameAsSnapshot(snap: CatalogSnapshot, c: number, list: any[] | null): boolean {
  const cat = c >= 0 ? snap.listCategory(c) : null;
  const n = cat ? cat.end - cat.start : 0;
  if ((list?.length ?? 0) !== n) return false;
  for (let i = 0; i < n; i++) if (JSON.stringify(list![i]) !== snap.listItemJson(cat!.start + i)) return false;
  return true;
}

/** null: the snapshot's list is current. Otherwise the list as the cache has it now. */
async function currentList(snap: CatalogSnapshot, key: string): Promise<ChangedList | null> {
  const version = xtreamCacheKeyVersion(key);
  if (listMatchesSnapshot(key, version)) return null;
  const have = changed.get(key);
  if (have && have.snap === snap && have.version === version) return have;
  const job = `${key}|${version}`;
  let p = checking.get(job);
  if (!p) {
    p = (async () => {
      const value = await xtreamCache.get<any[]>(key);
      const list = Array.isArray(value) ? value : null;
      // `version` was read before the list: a write during the read shows as a newer version.
      if (sameAsSnapshot(snap, snapshotCategory(snap, key), list)) {
        markListMatches(snap, key, version);
        changed.delete(key);
        return null;
      }
      const entry = { snap, version, list };
      changed.set(key, entry);
      return entry;
    })().finally(() => checking.delete(job));
    checking.set(job, p);
  }
  return p;
}

// ── the view ───────────────────────────────────────────────────────────────────

interface Browse {
  refs: number[];
  names: Map<number, string>;
  movedIn: any[];
  /** Per raw position: 1 = dropped by an override (hidden, moved out of "*"); else 0. */
  dropped: Uint8Array;
  /** Raw position -> override display name. */
  renamed: Map<number, string>;
}

export class AllView {
  /** Category id per raw part, and where each part starts (ascending). */
  private readonly partCat: string[] = [];
  private readonly partStart: number[] = [];
  /** Raw position -> snapshot entry (>= 0) or -1 - index into `extra`. */
  private readonly refs: Int32Array;
  /** Snapshot entry -> raw position, or -1 (not in a visible, current list). */
  private readonly posOfEntry: Int32Array;
  private readonly extra: any[] = [];
  private extraIndex: { norms: string[]; years: number[]; terms: Map<string, number[]>; byId: Map<string, number> } | null = null;
  private mark: Int8Array | null = null;
  private total: Int32Array | null = null;

  constructor(
    readonly fp: string,
    readonly type: CatalogType,
    readonly snap: CatalogSnapshot,
    parts: { cat: string; c: number; list: any[] | null; fromSnapshot: boolean }[],
  ) {
    let n = 0;
    for (const p of parts) n += p.fromSnapshot ? (p.c >= 0 ? snap.listCategory(p.c).end - snap.listCategory(p.c).start : 0) : (p.list?.length ?? 0);
    this.refs = new Int32Array(n);
    this.posOfEntry = new Int32Array(snap.listEntryCount).fill(-1);
    let pos = 0;
    for (const p of parts) {
      const start = pos;
      if (p.fromSnapshot) {
        if (p.c < 0) continue;
        const cat = snap.listCategory(p.c);
        if (cat.end === cat.start) continue;
        for (let k = cat.start; k < cat.end; k++) { this.refs[pos] = k; this.posOfEntry[k] = pos; pos++; }
      } else {
        if (!p.list || p.list.length === 0) continue;
        for (const item of p.list) { this.refs[pos++] = -1 - this.extra.length; this.extra.push(item); }
      }
      this.partCat.push(p.cat); this.partStart.push(start);
    }
  }

  get length(): number { return this.refs.length; }

  /** The portal entry at a raw position, as cached (a fresh object for snapshot entries). */
  private itemAt(pos: number): any {
    const r = this.refs[pos];
    return r >= 0 ? this.snap.listItem(r) : this.extra[-1 - r];
  }

  private idAt(pos: number): string {
    const r = this.refs[pos];
    return r >= 0 ? this.snap.listItemId(r) : itemIdOf(this.type, this.extra[-1 - r]);
  }

  private ensureExtraIndex() {
    if (this.extraIndex) return this.extraIndex;
    const norms: string[] = [], years: number[] = [], terms = new Map<string, number[]>(), byId = new Map<string, number>();
    for (let j = 0; j < this.extra.length; j++) {
      const item = this.extra[j];
      const norm = normalizeText(String(item?.name ?? ""));
      norms.push(norm);
      const y = String(item?.year ?? "").slice(0, 4);
      years.push(/^\d{4}$/.test(y) ? Number(y) : 0);
      const words = norm ? norm.split(" ") : [];
      const set = new Set(words);
      for (let i = 0; i + 1 < words.length; i++) set.add(words[i] + words[i + 1]);
      for (const t of set) { let l = terms.get(t); if (!l) terms.set(t, (l = [])); l.push(j); }
      const id = itemIdOf(this.type, item);
      if (!byId.has(id)) byId.set(id, j);
    }
    return (this.extraIndex = { norms, years, terms, byId });
  }

  /** Raw position of each extra entry (built on first use; extras are few). */
  private extraPosCache: Int32Array | null = null;
  private extraPositions(): Int32Array {
    if (!this.extraPosCache) {
      const out = new Int32Array(this.extra.length);
      for (let pos = 0; pos < this.refs.length; pos++) if (this.refs[pos] < 0) out[-1 - this.refs[pos]] = pos;
      this.extraPosCache = out;
    }
    return this.extraPosCache;
  }

  /** First raw position of an item id, or -1 (catalogUnion's catOf / byId: first found). */
  private firstPosOf(id: string): number {
    let best = -1;
    for (const k of this.snap.listEntriesWithId(this.type, id)) {
      const pos = this.posOfEntry[k];
      if (pos >= 0 && (best < 0 || pos < best)) best = pos;
    }
    if (this.extra.length) {
      const j = this.ensureExtraIndex().byId.get(id);
      if (j !== undefined) { const pos = this.extraPositions()[j]; if (best < 0 || pos < best) best = pos; }
    }
    return best;
  }

  /** The category an item was found in (first in genre order), as catalogUnion's catOf. */
  categoryOf(id: string | number): string | undefined {
    const pos = this.firstPosOf(String(id));
    if (pos < 0) return undefined;
    let lo = 0, hi = this.partStart.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.partStart[m] <= pos) lo = m; else hi = m - 1; }
    return this.partCat[lo];
  }

  /** The portal item with this id (first found), as catalogUnion's catalogItem. */
  item(id: string | number): any | null {
    const pos = this.firstPosOf(String(id));
    return pos < 0 ? null : this.itemAt(pos);
  }

  // ── browse ──

  private browsePromise: Promise<Browse> | null = null;
  private getBrowse(): Promise<Browse> {
    return (this.browsePromise ??= this.buildBrowse());
  }

  async browseList(): Promise<PagedList> {
    const b = await this.getBrowse();
    return {
      length: b.refs.length,
      page: (offset, count) => {
        const out: any[] = [];
        for (let i = Math.max(0, offset); i < Math.min(b.refs.length, offset + count); i++) {
          const r = b.refs[i];
          if (r < 0) { out.push(b.movedIn[-1 - r]); continue; }
          const item = this.itemAt(r);
          const name = b.names.get(i);
          out.push(name !== undefined ? { ...item, name } : item);
        }
        return out;
      },
    };
  }

  /** applyOverridesToUnion over positions (see the header for the rules). */
  private async buildBrowse(): Promise<Browse> {
    const type = this.type;
    const all = await getAllContentOverrides(type);
    const n = this.refs.length;
    const dropped = new Uint8Array(n), renamed = new Map<number, string>();
    if (all.size === 0) return { refs: Array.from({ length: n }, (_, i) => i), names: new Map(), movedIn: [], dropped, renamed };
    const used = new Map<string, any>();
    const present = new Set<string>();
    const refs: number[] = [];
    const keys: string[] = []; // override key per browse entry (for sort_order)
    const names = new Map<number, string>();
    for (let pos = 0; pos < n; pos++) {
      const key = overrideKeyOfId(type, this.idAt(pos));
      present.add(key.slice(type.length + 1));
      const ov = all.get(key);
      if (!ov) { refs.push(pos); keys.push(key); continue; }
      used.set(key, ov);
      if (ov.hidden || (ov.target_category_id && ov.target_category_id !== "*")) { dropped[pos] = 1; continue; }
      if (ov.display_name) { names.set(refs.length, ov.display_name); renamed.set(pos, ov.display_name); }
      refs.push(pos); keys.push(key);
    }
    // Items moved INTO "*" (rare), read from their original list as applyOverridesToUnion does.
    const movedIn: any[] = [];
    for (const ov of all.values()) {
      if (ov.target_category_id !== "*" || ov.hidden || !ov.original_category_id) continue;
      const itemId = String(ov.item_key).replace(`${type}_`, "");
      if (present.has(itemId)) continue;
      const src = (await xtreamCache.get<any[]>(listKey(type, ov.original_category_id))) ?? [];
      const srcItem = src.find((i: any) => itemIdOf(type, i) === itemId);
      if (!srcItem) continue;
      const item = { ...srcItem, id: itemId, name: ov.display_name ?? srcItem.name };
      refs.push(-1 - movedIn.length); keys.push(overrideKeyOfId(type, itemIdOf(type, item)));
      movedIn.push(item);
      used.set(contentKey(type, itemId), ov);
    }
    let hasSortOrder = false;
    for (const ov of used.values()) if (ov.sort_order != null) { hasSortOrder = true; break; }
    if (!hasSortOrder) return { refs, names, movedIn, dropped, renamed };
    // Same comparator as applyOverridesToUnion (order(a) - order(b), Infinity when none), on the
    // same entries in the same order: the stable sort gives the same permutation.
    const order = keys.map((k) => used.get(k)?.sort_order ?? Infinity);
    const idx = Array.from(refs.keys()).sort((a, b) => order[a] - order[b]);
    const sortedNames = new Map<number, string>();
    idx.forEach((from, to) => { const nm = names.get(from); if (nm !== undefined) sortedNames.set(to, nm); });
    return { refs: idx.map((i) => refs[i]), names: sortedNames, movedIn, dropped, renamed };
  }

  // ── search ──

  /** Raw positions matching `query`, ranked: SearchIndex.search over raw. */
  searchPositions(query: string): number[] {
    const n = this.refs.length;
    const all = () => Array.from({ length: n }, (_, i) => i);
    if (!query || !query.trim()) return all();
    const qNorm = normalizeText(query);
    const qWordsAll = qNorm ? qNorm.split(" ") : [];
    if (qWordsAll.length === 0) return all();
    const qYear = qWordsAll.find((w) => /^(19|20)\d\d$/.test(w)) ?? "";
    let qWords = qWordsAll.filter((w) => w !== qYear);
    const meaningful = qWords.filter((w) => !STOP_WORDS.has(w));
    if (meaningful.length > 0) qWords = meaningful;
    if (qWords.length === 0) qWords = qWordsAll;

    const mark = this.mark && this.mark.length === n ? this.mark : (this.mark = new Int8Array(n));
    const total = this.total && this.total.length === n ? this.total : (this.total = new Int32Array(n));
    const ex = this.extra.length ? this.ensureExtraIndex() : null;
    const exPos = ex ? this.extraPositions() : null;
    const bytes = (w: string) => Uint8Array.from(w, (ch) => ch.charCodeAt(0));
    let cand: Int32Array | null = null;
    let candLen = 0;
    let touched: number[] = [];
    // Marks d with match quality q (3 whole word, 2 prefix, 1 one edit away), keeping the best.
    const touch = (d: number, q: number) => { if (mark[d] === 0) touched.push(d); if (mark[d] < q) mark[d] = q; };
    for (const w of qWords) {
      touched = [];
      // Prefix matches (3 = the whole word, 2 = a prefix), visible entries only.
      const wb = bytes(w);
      const [lo, hi] = this.snap.termPrefixRange(wb);
      const post = this.snap.post, postOff = this.snap.postOff, posOf = this.posOfEntry;
      for (let vi = lo; vi < hi; vi++) {
        const q = this.snap.termLength(vi) === w.length ? 3 : 2;
        for (let k = postOff[vi], end = postOff[vi + 1]; k < end; k++) { const d = posOf[post[k]]; if (d >= 0) touch(d, q); }
      }
      if (ex) for (const [t, js] of ex.terms) if (t.startsWith(w)) { const q = t === w ? 3 : 2; for (const j of js) touch(exPos![j], q); }
      // One edit away, only when no visible title has the prefix (SearchIndex: no vocabulary term
      // has it; its vocabulary holds exactly the visible titles' terms).
      if (touched.length === 0 && w.length >= MIN_FUZZY_LEN) {
        const seen = new Set<string>();
        for (const e of editsOne(w)) {
          if (seen.has(e) || e.length < MIN_FUZZY_LEN - 1) continue;
          seen.add(e);
          const vi = this.snap.termIndex(e);
          if (vi >= 0) for (let k = postOff[vi], end = postOff[vi + 1]; k < end; k++) { const d = posOf[post[k]]; if (d >= 0) touch(d, 1); }
          const js = ex?.terms.get(e);
          if (js) for (const j of js) touch(exPos![j], 1);
        }
      }
      if (touched.length === 0) return [];
      if (cand === null) {
        cand = Int32Array.from(touched);
        candLen = cand.length;
        for (let k = 0; k < candLen; k++) total[cand[k]] = mark[cand[k]] - 1;
      } else {
        let out = 0;
        for (let k = 0; k < candLen; k++) { const d = cand[k]; if (mark[d] > 0) { total[d] += mark[d] - 1; cand[out++] = d; } }
        candLen = out;
      }
      for (const d of touched) mark[d] = 0;
      if (candLen === 0) return [];
    }

    const qJoined = qWords.join(" ");
    const qNormB = bytes(qNorm), qJoinedB = bytes(qJoined);
    const qYearNum = qYear ? Number(qYear) : 0;
    const BONUS = [0, 200, 500, 1000];
    // Score s (SearchIndex's formula) is a multiple of 0.5, so 2s is a whole number and
    // (-2s) * 2^20 + d sorts exactly as "s descending, then position ascending" (d < 2^20,
    // |2s| < 2^30): one native numeric sort instead of a comparator over objects.
    const keys = new Float64Array(candLen);
    for (let k = 0; k < candLen; k++) {
      const d = cand![k];
      const r = this.refs[d];
      let s = total[d] * 10;
      if (r >= 0) {
        // Snapshot titles are compared as bytes in the pool (ASCII), not decoded.
        const rel = this.snap.searchNormRelation(r, qNormB, qJoinedB);
        s += BONUS[rel & 3];
        if (qYearNum && this.snap.searchYear(r) === qYearNum) s += 300;
        s -= (rel >>> 2) * 0.5;
      } else {
        const norm = ex!.norms[-1 - r];
        if (norm === qNorm || norm === qJoined) s += 1000;
        else if (norm.startsWith(qJoined)) s += 500;
        else if (norm.includes(qJoined)) s += 200;
        if (qYearNum && ex!.years[-1 - r] === qYearNum) s += 300;
        s -= norm.length * 0.5;
      }
      keys[k] = -2 * s * 1048576 + d;
    }
    keys.sort();
    const out = new Array<number>(candLen);
    for (let k = 0; k < candLen; k++) { const key = keys[k]; out[k] = key - Math.floor(key / 1048576) * 1048576; }
    return out;
  }

  /** Ranked matches with overrides applied (filterBySearch + applyOverridesToMatches). */
  async search(query: string): Promise<PagedList> {
    const positions = this.searchPositions(query);
    // Each position's override (hidden or moved out: dropped; renamed) was worked out once for
    // the view with browse, by the same rules as applyOverridesToMatches.
    const b = await this.getBrowse();
    const kept: number[] = [];
    const names = new Map<number, string>();
    for (const pos of positions) {
      if (b.dropped[pos]) continue;
      const name = b.renamed.get(pos);
      if (name !== undefined) names.set(kept.length, name);
      kept.push(pos);
    }
    return {
      length: kept.length,
      page: (offset, count) => {
        const out: any[] = [];
        for (let i = Math.max(0, offset); i < Math.min(kept.length, offset + count); i++) {
          const item = this.itemAt(kept[i]);
          const name = names.get(i);
          out.push(name !== undefined ? { ...item, name } : item);
        }
        return out;
      },
    };
  }
}

const views = new Map<string, AllView>();
const building = new Map<string, Promise<AllView>>();

/**
 * The "*" catalog of `type` from the snapshot, or null when there is no snapshot yet or the
 * catalog is empty (callers then answer as before).
 */
export async function allView(type: CatalogType, profileId: number | undefined): Promise<AllView | null> {
  const snap = catalogSnapshot();
  if (!snap) return null;
  const genres = await readGenres(type, profileId);
  const hidden = await getHiddenGenreIds(type);
  const cats = genres.filter((g: any) => g.id && g.id !== "*" && !hidden.has(String(g.id))).map((g: any) => String(g.id));
  const states = await Promise.all(cats.map((cat) => currentList(snap, listKey(type, cat))));
  const fp = `${snap.version}|${overridesGeneration()}|${cats.map((cat, i) => `${cat}@${states[i] ? states[i]!.version : "s"}`).join(",")}`;
  const slot = `${profileId ?? 0}:${type}`;
  const have = views.get(slot);
  if (have && have.fp === fp && have.snap === snap) return have.length > 0 ? have : null;
  const job = `${slot}|${fp}`;
  let p = building.get(job);
  if (!p) {
    p = Promise.resolve().then(() => {
      const parts = cats.map((cat, i) => ({
        cat, c: snapshotCategory(snap, listKey(type, cat)), list: states[i]?.list ?? null, fromSnapshot: !states[i],
      }));
      const view = new AllView(fp, type, snap, parts);
      views.set(slot, view);
      return view;
    }).finally(() => building.delete(job));
    building.set(job, p);
  }
  const view = await p;
  return view.length > 0 ? view : null;
}
