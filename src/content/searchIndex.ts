// Title search index for movies/series (`/api/v2/movies|series?search=`).
//
// Replaces a per-request `name.toLowerCase().includes(query)` scan, which (a) only
// matched the exact query text in order ("spiderman" missed "Spider-Man", "dark knight
// batman" missed "Batman: The Dark Knight"), (b) had no typo tolerance and (c) returned
// results in catalog order, unranked.
//
// Design:
// - normalize(): NFKD + diacritics stripped, lowercase, "&" -> "and", apostrophes dropped,
//   any other non-alphanumeric -> word break. Each title also indexes the concatenation of
//   adjacent word pairs ("spider man" -> "spiderman") so joined/split spellings meet.
// - Inverted index over a sorted vocabulary: each query word is matched as a PREFIX of a
//   title word (binary search for the vocabulary range: O(log V + matches)), all query words
//   must match (AND), in any order. Typing feels instant: "dark kni" already matches.
// - Typo tolerance (one edit) via a SymSpell deletion map: every vocabulary term (len >= 4)
//   is stored under each of its single-character deletions; a query word's own deletions are
//   looked up the same way, so a candidate set within edit distance 1 is found in O(L) hash
//   lookups instead of comparing against the whole vocabulary. Only used when a word has
//   no prefix match.
// - Ranking: exact title > title starts with query > all words whole > prefix > fuzzy,
//   plus a bonus when the query contains the title's year, then shorter titles first.
// - Built once per catalog snapshot (fingerprinted by size + an id hash) and reused across
//   requests; a rebuild costs one pass over the titles.

export interface Searchable {
  name?: string;
  year?: string | number;
  stream_id?: string | number;
  series_id?: string | number;
  id?: string | number;
}

const STOP_WORDS = new Set(["the", "a", "an", "of", "and"]);
const MIN_FUZZY_LEN = 4;

export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokensOf(norm: string): string[] {
  return norm ? norm.split(" ") : [];
}

function deletions(term: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < term.length; i++) out.push(term.slice(0, i) + term.slice(i + 1));
  return out;
}

/** True Damerau (OSA) distance <= 1, cheap check without a full DP matrix. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // transposition
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1); // deletion / insertion
}

interface Doc {
  norm: string;          // normalized full title
  words: Set<string>;    // its words (and adjacent-pair joins)
  year: string;
  len: number;
}

export class SearchIndex<T extends Searchable> {
  private readonly docs: Doc[];
  private readonly vocab: string[];             // sorted unique terms
  private readonly postings: Int32Array[];      // vocab index -> doc ids (ascending)
  private readonly deletes = new Map<string, number[]>(); // SymSpell: deletion -> vocab indices

  constructor(readonly items: T[]) {
    const termDocs = new Map<string, number[]>();
    this.docs = items.map((item, docId) => {
      const norm = normalizeText(String(item.name ?? ""));
      const words = tokensOf(norm);
      const terms = new Set(words);
      for (let i = 0; i + 1 < words.length; i++) terms.add(words[i] + words[i + 1]);
      for (const t of terms) {
        let list = termDocs.get(t);
        if (!list) termDocs.set(t, (list = []));
        list.push(docId);
      }
      return { norm, words: terms, year: String(item.year ?? "").slice(0, 4), len: norm.length };
    });
    this.vocab = [...termDocs.keys()].sort();
    this.postings = this.vocab.map((t) => Int32Array.from(termDocs.get(t)!));
    this.vocab.forEach((term, vi) => {
      if (term.length < MIN_FUZZY_LEN) return;
      for (const d of [term, ...deletions(term)]) {
        let list = this.deletes.get(d);
        if (!list) this.deletes.set(d, (list = []));
        list.push(vi);
      }
    });
  }

  private markBuf: Int8Array | null = null;
  private totalBuf: Int32Array | null = null;
  private scratchMark(n: number): Int8Array { return this.markBuf && this.markBuf.length === n ? this.markBuf : (this.markBuf = new Int8Array(n)); }
  private scratchTotal(n: number): Int32Array { return this.totalBuf && this.totalBuf.length === n ? this.totalBuf : (this.totalBuf = new Int32Array(n)); }

  /** Vocabulary index range [lo, hi) of terms starting with `prefix` (binary search). */
  private prefixRange(prefix: string): [number, number] {
    let lo = 0, hi = this.vocab.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.vocab[mid] < prefix) lo = mid + 1; else hi = mid; }
    const start = lo;
    hi = this.vocab.length;
    const upper = prefix + "￿";
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.vocab[mid] < upper) lo = mid + 1; else hi = mid; }
    return [start, lo];
  }

  /** Vocabulary indices within one edit of `word` (SymSpell lookup + verification). */
  private fuzzyTerms(word: string): number[] {
    if (word.length < MIN_FUZZY_LEN) return [];
    const seen = new Set<number>();
    for (const d of [word, ...deletions(word)]) {
      for (const vi of this.deletes.get(d) ?? []) {
        if (!seen.has(vi) && withinOneEdit(word, this.vocab[vi])) seen.add(vi);
      }
    }
    return [...seen];
  }

  /** Ranked matches for `query`; empty query returns everything in original order. */
  search(query: string): T[] {
    const qNorm = normalizeText(query);
    const qWordsAll = tokensOf(qNorm);
    if (qWordsAll.length === 0) return this.items;
    // A 4-digit year in the query boosts rather than filters (titles rarely contain it).
    const qYear = qWordsAll.find((w) => /^(19|20)\d\d$/.test(w)) ?? "";
    let qWords = qWordsAll.filter((w) => w !== qYear);
    // Drop stop words unless the query is only stop words ("the", "it" stays searchable).
    const meaningful = qWords.filter((w) => !STOP_WORDS.has(w));
    if (meaningful.length > 0) qWords = meaningful;
    if (qWords.length === 0) qWords = qWordsAll;

    // Per query word: mark matching docs with how well they matched (3 whole word, 2 prefix,
    // 1 fuzzy) in a reused Int8Array; candidates are intersected in place in an Int32Array.
    // No per-query Maps: O(sum of postings) work and allocation-free on the hot path.
    const n = this.docs.length;
    const mark = this.scratchMark(n);
    const total = this.scratchTotal(n);
    let cand: Int32Array | null = null;
    let candLen = 0;
    for (const w of qWords) {
      const [lo, hi] = this.prefixRange(w);
      const touched: number[] = [];
      const touch = (d: number, q: number) => { if (mark[d] === 0) touched.push(d); if (mark[d] < q) mark[d] = q; };
      for (let vi = lo; vi < hi; vi++) {
        const q = this.vocab[vi] === w ? 3 : 2;
        const p = this.postings[vi];
        for (let k = 0; k < p.length; k++) touch(p[k], q);
      }
      if (lo === hi) for (const vi of this.fuzzyTerms(w)) { const p = this.postings[vi]; for (let k = 0; k < p.length; k++) touch(p[k], 1); }
      if (touched.length === 0) { return []; }
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
    const candidates = new Map<number, number>();
    for (let k = 0; k < candLen; k++) candidates.set(cand![k], total[cand![k]]);

    const qJoined = qWords.join(" ");
    const scored: { d: number; s: number }[] = [];
    for (const [d, quality] of candidates) {
      const doc = this.docs[d];
      let s = quality * 10;
      if (doc.norm === qNorm || doc.norm === qJoined) s += 1000;
      else if (doc.norm.startsWith(qJoined)) s += 500;
      else if (doc.norm.includes(qJoined)) s += 200;
      if (qYear && doc.year === qYear) s += 300;
      s -= doc.len * 0.5; // shorter (closer) titles first
      scored.push({ d, s });
    }
    scored.sort((a, b) => b.s - a.s || a.d - b.d);
    return scored.map((x) => this.items[x.d]);
  }
}

// ── Snapshot cache ──────────────────────────────────────────────────────────
// Routes re-read the catalog from the DB cache per request (new objects each time), so
// indexes are keyed by a cheap fingerprint of the snapshot: size + a rolling hash of ids.
// O(n) integer work per request instead of O(n·L) string lowercasing + matching.
const indexCache = new Map<string, { fp: string; index: SearchIndex<any> }>();
const MAX_INDEXES = 64;

function fingerprint(items: Searchable[]): string {
  let h = 2166136261 >>> 0;
  for (const it of items) {
    const id = String(it.stream_id ?? it.series_id ?? it.id ?? it.name ?? "");
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
    h = Math.imul(h ^ 0x2c, 16777619) >>> 0;
  }
  return `${items.length}:${h}`;
}

/** Ranked search over `items`, reusing an index built for the same snapshot under `key`. */
export function searchCatalog<T extends Searchable>(key: string, items: T[], query: string): T[] {
  if (!query || !query.trim()) return items;
  let entry = indexCache.get(key);
  // Callers holding a long-lived snapshot (content/catalogUnion.ts) pass the same array every
  // time: identity proves it is the indexed snapshot, so skip the O(n) fingerprint.
  const fp = entry && entry.index.items === items ? entry.fp : fingerprint(items);
  if (!entry || entry.fp !== fp) {
    entry = { fp, index: new SearchIndex(items) };
    indexCache.delete(key);
    indexCache.set(key, entry);
    if (indexCache.size > MAX_INDEXES) indexCache.delete(indexCache.keys().next().value as string);
  } else {
    indexCache.delete(key); // LRU touch
    indexCache.set(key, entry);
  }
  return (entry.index as SearchIndex<T>).search(query);
}
