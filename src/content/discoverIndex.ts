// In-memory Discover index — answers /discover/facets and /discover/browse without
// touching SQLite on the hot path.
//
// Measured on a copy of the live database (117k content_meta rows, 94k representative,
// 209k genre / 107k country / 10k theme tags), the per-request SQL this replaces took:
//   facets (4 GROUP BYs)           ~4.1 s   (languages alone 3.2 s: wide-row reads)
//   browse page, no filter         0.6–3.9 s (sorted ~94k rows to return 40)
//   browse count, genre "Drama"    2.9 s    (27,750 PK lookups into wide rows)
// and the old result cache expired every 10 minutes, so those costs recurred.
//
// Layout (built once per invalidation, ~2 MB):
//   - every representative title gets a RANK = its position in "newest enrichment first"
//     order; ids/type/language are parallel arrays indexed by rank
//   - each genre/country/theme value maps to an ascending Int32Array of ranks (postings)
//   - facet counts are precomputed per type ("all", "movie", "series")
// A browse is then: intersect the postings of the selected tags (smallest list first,
// binary-search probes into the others), skip ranks failing type/language/hidden, and
// slice the page — O(smallest posting · log) worst case, O(page) for the unfiltered
// feed. Only the 40 rows of the page are read from SQLite (by primary key).
//
// Invalidation: clearDiscoverCache() (enrichment runs, content-manager edits, duplicate
// reconciliation) drops the index and schedules a background rebuild; a request arriving
// before it finishes joins the same build (single-flight). Built at startup too.
// Facet counts count each (title, value) once: the live tag tables hold some duplicate
// rows, which the old GROUP BY counted twice. Hidden
// titles are applied at query time from the override generation, so hiding/unhiding a
// title is reflected immediately without a rebuild.

import { splitChannel } from "@/content/channelNames";
import { QueryTypes } from "sequelize";
import { sequelize } from "@/db";
import { logger } from "@/infra/logger";

export type TagKind = "genre" | "country" | "theme" | "network";
type TypeKey = "all" | "movie" | "series";

const TYPE_MOVIE = 1;
const TYPE_SERIES = 2;

export interface DiscoverIndex {
  ids: string[];                 // rank -> content_meta.id
  type: Uint8Array;              // rank -> TYPE_MOVIE | TYPE_SERIES | 0
  lang: Int32Array;              // rank -> index into langs (-1 = none)
  langs: string[];
  langIndex: Map<string, number>;
  rankOf: Map<string, number>;   // id -> rank
  postings: Record<TagKind, Map<string, Int32Array>>;
  facets: Record<TypeKey, {
    genres: { value: string; count: number }[];
    countries: { value: string; count: number }[];
    themes: { value: string; count: number }[];
    languages: { value: string; count: number }[];
    networks: { value: string; count: number }[];
  }>;
  builtAt: number;
}

let current: DiscoverIndex | null = null;
let building: Promise<DiscoverIndex> | null = null;
let generation = 0; // bumped on invalidate so a build started before it is not kept

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

/** Drop the index and rebuild it shortly after (debounced), so no request waits on it. */
export function invalidateDiscoverIndex(): void {
  generation++;
  current = null;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    getDiscoverIndex().catch((e) => logger.error(`[discoverIndex] rebuild failed: ${e?.message ?? e}`));
  }, 2000);
  rebuildTimer.unref?.();
}

/** Build at startup in the background (server.ts). */
export function primeDiscoverIndex(): void {
  getDiscoverIndex().catch((e) => logger.error(`[discoverIndex] startup build failed: ${e?.message ?? e}`));
}

export async function getDiscoverIndex(): Promise<DiscoverIndex> {
  if (current) return current;
  if (building) return building;
  const gen = generation;
  building = buildIndex()
    .then((idx) => {
      if (gen === generation) current = idx;
      return idx;
    })
    .finally(() => { building = null; });
  return building;
}

function typeKeyOf(t: number): TypeKey { return t === TYPE_MOVIE ? "movie" : t === TYPE_SERIES ? "series" : "all"; }

async function buildIndex(): Promise<DiscoverIndex> {
  const t0 = Date.now();
  // Served from idx_content_meta_discover (db/index.ts) — a covering index, so this reads
  // the narrow index only, never the wide content_meta rows, and comes back pre-sorted.
  const rows = await sequelize.query<{ id: string; type: string; originalLanguage: string | null }>(
    "SELECT id, type, originalLanguage FROM content_meta WHERE isRepresentative = 1 ORDER BY enrichedAt DESC, id ASC",
    { type: QueryTypes.SELECT },
  );
  const n = rows.length;
  const ids = new Array<string>(n);
  const type = new Uint8Array(n);
  const lang = new Int32Array(n);
  const langs: string[] = [];
  const langIndex = new Map<string, number>();
  const rankOf = new Map<string, number>();
  for (let r = 0; r < n; r++) {
    const row = rows[r];
    ids[r] = row.id;
    rankOf.set(row.id, r);
    type[r] = row.type === "movie" ? TYPE_MOVIE : row.type === "series" ? TYPE_SERIES : 0;
    const l = row.originalLanguage;
    if (l) {
      let li = langIndex.get(l);
      if (li === undefined) { li = langs.length; langs.push(l); langIndex.set(l, li); }
      lang[r] = li;
    } else lang[r] = -1;
  }

  const tables: Record<Exclude<TagKind, "network">, string> = { genre: "content_genres", country: "content_countries", theme: "content_themes" };
  const postings = { genre: new Map(), country: new Map(), theme: new Map(), network: new Map() } as Record<TagKind, Map<string, Int32Array>>;
  // The channel a title airs on comes from its name ("Zee5 : Manemagalu"); only names with
  // a separator can carry one, so the scan reads just those.
  const channelRows = (await sequelize.query<{ id: string; name: string }>(
    "SELECT id, name FROM content_meta WHERE isRepresentative = 1 AND (instr(name, ':') > 0 OR instr(name, '|') > 0 OR instr(name, ' - ') > 0)",
    { type: QueryTypes.SELECT },
  )).flatMap((row) => {
    const channel = splitChannel(row.name).channel;
    return channel ? [{ contentId: row.id, value: channel }] : [];
  });
  for (const kind of [...Object.keys(tables), "network"] as TagKind[]) {
    const tagRows = kind === "network" ? channelRows : await sequelize.query<{ contentId: string; value: string }>(
      `SELECT contentId, value FROM ${tables[kind as Exclude<TagKind, "network">]} WHERE isRepresentative = 1`,
      { type: QueryTypes.SELECT },
    );
    const lists = new Map<string, number[]>();
    for (const tr of tagRows) {
      const r = rankOf.get(tr.contentId);
      if (r === undefined) continue; // tag row for a title that is no longer representative
      let list = lists.get(tr.value);
      if (!list) lists.set(tr.value, (list = []));
      list.push(r);
    }
    for (const [value, list] of lists) {
      const arr = Int32Array.from(list).sort();
      // a title tagged twice with the same value would double-count; dedupe in place
      let w = 0;
      for (let i = 0; i < arr.length; i++) if (i === 0 || arr[i] !== arr[i - 1]) arr[w++] = arr[i];
      postings[kind].set(value, w === arr.length ? arr : arr.slice(0, w));
    }
  }

  const facets = {} as DiscoverIndex["facets"];
  for (const tk of ["all", "movie", "series"] as TypeKey[]) {
    const want = tk === "movie" ? TYPE_MOVIE : tk === "series" ? TYPE_SERIES : -1;
    const count = (arr: Int32Array) => {
      if (want === -1) return arr.length;
      let c = 0;
      for (let i = 0; i < arr.length; i++) if (type[arr[i]] === want) c++;
      return c;
    };
    const tagFacet = (kind: TagKind) => [...postings[kind]]
      .map(([value, arr]) => ({ value, count: count(arr) }))
      .filter((f) => f.count > 0)
      .sort((a, b) => b.count - a.count);
    const langCounts = new Int32Array(langs.length);
    for (let r = 0; r < n; r++) if (lang[r] >= 0 && (want === -1 || type[r] === want)) langCounts[lang[r]]++;
    facets[tk] = {
      genres: tagFacet("genre"),
      countries: tagFacet("country"),
      themes: tagFacet("theme"),
      networks: tagFacet("network"),
      languages: langs.map((value, i) => ({ value, count: langCounts[i] })).filter((f) => f.count > 0).sort((a, b) => b.count - a.count),
    };
  }

  logger.info(`[discoverIndex] built: ${n} titles, ${postings.genre.size} genres, ${postings.country.size} countries, ${postings.theme.size} themes, ${postings.network.size} channels in ${Date.now() - t0} ms`);
  return { ids, type, lang, langs, langIndex, rankOf, postings, facets, builtAt: Date.now() };
}

export function facetsFor(idx: DiscoverIndex, type?: string) {
  return idx.facets[type === "movie" || type === "series" ? type : "all"];
}

/** Smallest index i in arr[lo..] with arr[i] >= x (arr ascending). */
function lowerBound(arr: Int32Array, x: number, lo: number): number {
  let hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

export interface BrowseQuery {
  type?: string;
  language?: string;
  tags: { kind: TagKind; value: string }[];
  hidden: Set<string>;
  page: number;
  pageSize: number;
}

/** Matching ids for one page (newest first) and the total match count. */
export function browse(idx: DiscoverIndex, q: BrowseQuery): { ids: string[]; total: number } {
  const want = q.type === "movie" ? TYPE_MOVIE : q.type === "series" ? TYPE_SERIES : -1;
  let wantLang = -2; // -2 = no language filter
  if (q.language) {
    const li = idx.langIndex.get(q.language);
    if (li === undefined) return { ids: [], total: 0 };
    wantLang = li;
  }
  const hiddenRanks = new Set<number>();
  for (const id of q.hidden) { const r = idx.rankOf.get(id); if (r !== undefined) hiddenRanks.add(r); }
  const keep = (r: number) =>
    (want === -1 || idx.type[r] === want) && (wantLang === -2 || idx.lang[r] === wantLang) && !hiddenRanks.has(r);

  const start = (q.page - 1) * q.pageSize;
  const end = start + q.pageSize;
  const out: string[] = [];
  let total = 0;
  const take = (r: number) => { if (total >= start && total < end) out.push(idx.ids[r]); total++; };

  if (q.tags.length === 0) {
    const n = idx.ids.length;
    if (want === -1 && wantLang === -2) {
      // Unfiltered feed: the count is arithmetic, the page is a slice (skipping hidden).
      if (hiddenRanks.size === 0) return { ids: idx.ids.slice(start, Math.min(end, n)), total: n };
    }
    for (let r = 0; r < n; r++) if (keep(r)) take(r);
    return { ids: out, total };
  }

  const lists: Int32Array[] = [];
  for (const t of q.tags) {
    const arr = idx.postings[t.kind].get(t.value);
    if (!arr || arr.length === 0) return { ids: [], total: 0 };
    lists.push(arr);
  }
  lists.sort((a, b) => a.length - b.length);
  const [base, ...rest] = lists;
  const cursors = rest.map(() => 0);
  outer: for (let i = 0; i < base.length; i++) {
    const r = base[i];
    for (let k = 0; k < rest.length; k++) {
      const pos = lowerBound(rest[k], r, cursors[k]);
      cursors[k] = pos;
      if (pos >= rest[k].length) break outer; // this list is exhausted: no later rank can match
      if (rest[k][pos] !== r) continue outer;
    }
    if (keep(r)) take(r);
  }
  return { ids: out, total };
}

export interface RecommendQuery {
  genres: string[];              // the user's top genres (≤ 5)
  languages: string[];           // keep only these original languages (empty = any)
  type?: string;
  exclude: Set<string>;          // watched ids, their whole title groups, hidden titles
  limit: number;
}

/**
 * Representative titles ranked by how many of `genres` they carry (ties: newest first).
 * O(sum of the genres' postings) with a byte counter per rank; replaces a JOIN + GROUP BY
 * that took 1.1–1.5 s per request on the live data.
 */
export function recommend(idx: DiscoverIndex, q: RecommendQuery): string[] {
  const want = q.type === "movie" ? TYPE_MOVIE : q.type === "series" ? TYPE_SERIES : -1;
  let langOk: Set<number> | null = null;
  if (q.languages.length > 0) {
    langOk = new Set();
    for (const l of q.languages) { const li = idx.langIndex.get(l); if (li !== undefined) langOk.add(li); }
    if (langOk.size === 0) return [];
  }
  const overlap = new Uint8Array(idx.ids.length);
  const touched: number[] = [];
  for (const g of q.genres) {
    const arr = idx.postings.genre.get(g);
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) { const r = arr[i]; if (overlap[r]++ === 0) touched.push(r); }
  }
  // Bucket by overlap count, ranks ascending inside each bucket (= newest first).
  touched.sort((a, b) => a - b);
  const buckets: number[][] = [];
  for (const r of touched) {
    if (want !== -1 && idx.type[r] !== want) continue;
    if (langOk && !langOk.has(idx.lang[r])) continue;
    if (q.exclude.has(idx.ids[r])) continue;
    (buckets[overlap[r]] ??= []).push(r);
  }
  const out: string[] = [];
  for (let c = buckets.length - 1; c >= 1 && out.length < q.limit; c--) {
    const b = buckets[c];
    if (!b) continue;
    for (let i = 0; i < b.length && out.length < q.limit; i++) out.push(idx.ids[b[i]]);
  }
  return out;
}
