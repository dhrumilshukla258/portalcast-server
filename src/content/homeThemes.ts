// What keeps Home fresh (owner, 2026-10-22: "it should not always show Top rated; keep changing
// so viewers feel there is new content in town"). Three kinds of rows, used by content/home.ts:
//
//   new      "Just added": titles the provider added lately, newest first (never the first
//            import: on a new install everything is new, which says nothing)
//   trending "Trending this week": TMDB's worldwide trending, limited to titles this server has
//            (refreshed every 6 h; without a TMDB key home.ts keeps its vote-based chart)
//   theme    rows that change every day, chosen per viewer from their genres and language:
//            "Horror classics", "Hidden gems: Thriller", "Best of 2016", "1990s favourites",
//            "Best in Hindi", now and then "All-time greats" (the old Top rated)
//
// Facts per title (year, rating, votes, first seen) are packed arrays by Discover rank, built
// from one query per catalog change, like the charts.

import { QueryTypes } from "sequelize";
import { sequelize } from "@/db";
import type { DiscoverIndex } from "@/content/discoverIndex";
import { fetchTrendingIds } from "@/content/tmdb";
import { logger } from "@/infra/logger";

const TYPE_SERIES = 2;
const DAY = 86_400_000;

export interface TitleFacts {
  /** By Discover rank: release year (0 unknown), rating 0-10, votes, first seen (ms). */
  year: Int16Array;
  rating: Float32Array;
  votes: Int32Array;
  added: Float64Array;
  /** By rank (ms, 0 unknown): the provider's date, earliest of its versions, and the latest (a
   *  series' last_modified moves when episodes are added: New episodes). */
  providerAdded: Float64Array;
  providerLatest: Float64Array;
  /** "movie:603" / "series:1396" -> rank. */
  byTmdb: Map<string, number>;
  /** "movie|the night agent" (type and [nameKey]) -> rank, the best-known title of that name. */
  byName: Map<string, number>;
  /** Titles first seen after this are "new" (the first import ends here). */
  newSince: number;
}

let factsCache: { key: string; value: Promise<TitleFacts> } | null = null;

function yearOf(r: any): number {
  const fromDate = /^(\d{4})/.exec(String(r.premiered ?? ""));
  const y = fromDate ? Number(fromDate[1]) : parseInt(String(r.year ?? ""), 10);
  return y >= 1900 && y <= 2100 ? y : 0;
}

const PLAIN = /^[\x20-\x7e]*$/;

/** A title name for matching: no accents, case, punctuation, year in brackets or leading "The". */
export function nameKey(s: string): string {
  // Most names are plain ASCII, where taking accents off changes nothing (and costs the most).
  return (PLAIN.test(s) ? s : s.normalize("NFKD").replace(/\p{M}/gu, ""))
    .toLowerCase()
    .replace(/\(\d{4}\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

const foldKey = (r: any) => (r.tmdbId ? `${r.type === "series" ? "series" : "movie"}:${r.tmdbId}` : `g:${r.groupKey || r.id}`);

const PAGE = 4_000;
const pause = () => new Promise<void>((r) => setImmediate(r));

/** content_meta in pages of [PAGE] rows, in rowid (storage) order like the single read it
 *  replaces and like catalog/builder.ts: memory stays flat and other requests run between pages
 *  instead of waiting seconds for the whole catalog. */
async function* metaPages(columns: string): AsyncGenerator<any[]> {
  for (let after = -1; ;) {
    const rows = (await sequelize.query(`SELECT rowid AS _rid, ${columns} FROM content_meta WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`, {
      replacements: [after],
      type: QueryTypes.SELECT,
    })) as any[];
    if (!rows.length) return;
    yield rows;
    after = rows[rows.length - 1]._rid;
    await pause();
  }
}

/** Facts for every title in the index; one read of the catalog per catalog change. */
export function titleFacts(idx: DiscoverIndex, catalogGen: number): Promise<TitleFacts> {
  const key = `${idx.builtAt}.${catalogGen}`;
  if (factsCache?.key === key) return factsCache.value;
  const value = (async () => {
    const n = idx.ids.length;
    const year = new Int16Array(n), rating = new Float32Array(n), votes = new Int32Array(n);
    const added = new Float64Array(n).fill(Infinity);
    const providerAdded = new Float64Array(n), providerLatest = new Float64Array(n);
    const imdbVotes = new Int32Array(n);
    const byTmdb = new Map<string, number>();
    // Versions of a title (separate groups, other languages) fold onto the card's rank: by TMDB
    // id, else by group key. A rating is often stored on another version than the card's.
    const rankOfFold = new Map<string, number>();
    for await (const rows of metaPages("id, type, tmdbId, groupKey")) {
      for (const r of rows) {
        const rank = idx.rankOf.get(String(r.id));
        if (rank !== undefined) rankOfFold.set(foldKey(r), rank);
      }
    }
    // Names, for charts that list titles by name (Netflix Top 10): the cleaned name and the
    // original title, per type; a name shared by several titles goes to the best-known one
    // (once every vote is known, below).
    const nameKeys: string[] = [], nameRanks: number[] = [];
    let firstSeen = Infinity;
    for await (const rows of metaPages("type, tmdbId, groupKey, id, year, premiered, imdbRating, imdbVotes, rating, ratingCount, createdAt, name, trimmedName, originalTitle, providerAddedAt")) {
      for (const r of rows) {
        const t = Date.parse(String(r.createdAt ?? ""));
        if (Number.isFinite(t) && t < firstSeen) firstSeen = t;
        const rank = rankOfFold.get(foldKey(r));
        if (rank === undefined) continue;
        if (Number.isFinite(t) && t < added[rank]) added[rank] = t;
        const pa = Number(r.providerAddedAt) * 1000;
        if (pa > 0) {
          if (!providerAdded[rank] || pa < providerAdded[rank]) providerAdded[rank] = pa;
          if (pa > providerLatest[rank]) providerLatest[rank] = pa;
        }
        if (!year[rank]) year[rank] = yearOf(r);
        const iv = Number(r.imdbVotes) || 0, ir = Number(r.imdbRating) || 0;
        if (ir > 0 && iv > imdbVotes[rank]) { imdbVotes[rank] = iv; rating[rank] = ir; votes[rank] = Math.max(votes[rank], iv); }
        const tv = Number(r.ratingCount) || 0, tr = Number(r.rating) || 0;
        if (!imdbVotes[rank] && tr > 0 && tv > votes[rank]) { rating[rank] = tr; votes[rank] = tv; }
        const type = r.type === "series" ? "series" : "movie";
        if (r.tmdbId) byTmdb.set(`${type}:${r.tmdbId}`, rank);
        let last = "";
        for (const name of [r.trimmedName, r.name, r.originalTitle]) {
          if (!name || name === last) continue; // the cleaned name is often the name itself
          last = name;
          const k = nameKey(String(name));
          if (k) { nameKeys.push(`${type}|${k}`); nameRanks.push(rank); }
        }
      }
    }
    const byName = new Map<string, number>();
    for (let i = 0; i < nameKeys.length; i++) {
      const have = byName.get(nameKeys[i]);
      if (have === undefined || votes[nameRanks[i]] > votes[have]) byName.set(nameKeys[i], nameRanks[i]);
    }
    return { year, rating, votes, added, providerAdded, providerLatest, byTmdb, byName, newSince: firstSeen + 3 * DAY };
  })();
  factsCache = { key, value };
  value.catch(() => { if (factsCache?.value === value) factsCache = null; });
  return value;
}

// ── trending online ────────────────────────────────────────────────────────────────

const TRENDING_TTL = 6 * 3600_000;
let trending: { at: number; value: Promise<{ movie: number[]; series: number[] } | null> } | null = null;

/** TMDB's trending this week (TMDB ids, most trending first); null without a TMDB key. */
export function onlineTrending(): Promise<{ movie: number[]; series: number[] } | null> {
  if (trending && Date.now() - trending.at < TRENDING_TTL) return trending.value;
  const value = (async () => {
    const [movie, tv] = await Promise.all([fetchTrendingIds("movie"), fetchTrendingIds("tv")]);
    if (!movie && !tv) return null;
    logger.debug(`[home] TMDB trending: ${movie?.length ?? 0} movies, ${tv?.length ?? 0} series`);
    return { movie: movie ?? [], series: tv ?? [] };
  })();
  trending = { at: Date.now(), value };
  value.catch(() => { if (trending?.value === value) trending = null; });
  return value;
}

/** Changes when trending was fetched again: Home rows built before are stale. */
export function trendingStamp(): number {
  return trending?.at ?? 0;
}

// ── rows ───────────────────────────────────────────────────────────────────────────

/**
 * Titles the provider added in the last 30 days, newest first: by the provider's own date where
 * it has one, else when this server first saw the title (never the first import: on a new install
 * everything is new, which says nothing).
 */
export function justAdded(idx: DiscoverIndex, facts: TitleFacts, ok: (r: number) => boolean, now = Date.now()): number[] {
  const since = now - 30 * DAY;
  const when = (r: number) => facts.providerAdded[r] || (facts.added[r] >= facts.newSince ? facts.added[r] : 0);
  const out: number[] = [];
  for (let r = 0; r < idx.ids.length; r++) {
    const t = when(r);
    if (t >= since && t !== Infinity && t <= now + DAY && ok(r)) out.push(r);
  }
  return out.sort((a, b) => when(b) - when(a) || a - b);
}

/**
 * The viewer's series with episodes added since they last watched (the provider moved the
 * series' date after it), in the last 30 days, newest first.
 */
export function newEpisodes(facts: TitleFacts, watched: { rank: number; at: number }[], ok: (r: number) => boolean, now = Date.now()): number[] {
  return watched
    .filter(({ rank, at }) => facts.providerLatest[rank] > at && facts.providerLatest[rank] >= now - 30 * DAY && ok(rank))
    .sort((a, b) => facts.providerLatest[b.rank] - facts.providerLatest[a.rank])
    .map(({ rank }) => rank);
}

/** Trending ranks this server has, in TMDB's order; movies and series interleaved for "all". */
export function trendingRanks(facts: TitleFacts, t: { movie: number[]; series: number[] }, want: "all" | "movie" | "series", ok: (r: number) => boolean): number[] {
  const of = (kind: "movie" | "series") => t[kind].map((id) => facts.byTmdb.get(`${kind}:${id}`)).filter((r): r is number => r !== undefined && ok(r));
  if (want !== "all") return of(want);
  const m = of("movie"), s = of("series"), out: number[] = [];
  for (let i = 0; i < Math.max(m.length, s.length); i++) { if (i < m.length) out.push(m[i]); if (i < s.length) out.push(s[i]); }
  return out;
}

interface Theme { key: string; title: string; ranks: () => number[] }

/** A day number in the server's time zone: themes change at midnight, not mid-evening. */
export function dayNumber(now = new Date()): number {
  return Math.floor((now.getTime() - now.getTimezoneOffset() * 60_000) / DAY);
}

function rng(seedText: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [xs] in an order fixed by [seed] (the same seed, the same order). */
export function shuffled<T>(xs: T[], seed: string): T[] {
  const rand = rng(seed), out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

let languageNames: Intl.DisplayNames | null = null;
function languageName(code: string): string {
  try {
    languageNames ??= new Intl.DisplayNames(["en"], { type: "language" });
    const name = languageNames.of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : code;
  } catch {
    return code;
  }
}

/**
 * Today's themed rows for one viewer: up to [count], each ranked best first, only titles [ok]
 * allows (not watched, not hidden, the asked type). Chosen by a per-viewer, per-day seed, so
 * Home stays the same through the day and changes the next; the viewer's genres and language
 * weigh in, with some rows from outside them so it does not narrow down to one taste.
 */
export function dailyThemes(args: {
  idx: DiscoverIndex;
  facts: TitleFacts;
  ok: (r: number) => boolean;
  seed: string;
  /** The viewer's genres, most watched first (empty for a new viewer). */
  genres: string[];
  /** The viewer's languages by weight (index into idx.langs). */
  langs: number[];
  /** Genres the catalog has most of, for viewers without history and for variety. */
  catalogGenres: string[];
  count: number;
  minRow: number;
}): { key: string; title: string; ranks: number[] }[] {
  const { idx, facts, ok, count, minRow } = args;
  const rand = rng(args.seed);
  const pick = <T>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(rand() * xs.length)] : undefined);
  const thisYear = new Date().getFullYear();
  const seriesScale = (r: number) => (idx.type[r] === TYPE_SERIES ? 0.4 : 1); // series get fewer votes
  const best = (ranks: Iterable<number>, keep: (r: number) => boolean) => {
    const out: number[] = [];
    for (const r of ranks) if (ok(r) && facts.rating[r] > 0 && keep(r)) out.push(r);
    return out.sort((a, b) => facts.rating[b] - facts.rating[a] || facts.votes[b] - facts.votes[a]);
  };
  const all = { *[Symbol.iterator]() { for (let r = 0; r < idx.ids.length; r++) yield r; } };
  const genreRanks = (g: string) => idx.postings.genre.get(g) ?? new Int32Array(0);

  const genreTheme = (g: string): Theme => {
    const kind = pick(["classics", "gems", "recent"] as const)!;
    if (kind === "classics") {
      return { key: `theme:classics:${g}`, title: `${g} classics`, ranks: () => best(genreRanks(g), (r) => facts.year[r] > 0 && facts.year[r] < 2000 && facts.votes[r] >= 10_000 * seriesScale(r)) };
    }
    if (kind === "gems") {
      return { key: `theme:gems:${g}`, title: `Hidden gems: ${g}`, ranks: () => best(genreRanks(g), (r) => facts.rating[r] >= 7 && facts.votes[r] >= 1_000 * seriesScale(r) && facts.votes[r] <= 25_000) };
    }
    return { key: `theme:recent:${g}`, title: `Recent ${g} favourites`, ranks: () => best(genreRanks(g), (r) => facts.year[r] >= thisYear - 3 && facts.votes[r] >= 3_000 * seriesScale(r)) };
  };
  const timeTheme = (): Theme => {
    if (rand() < 0.6) {
      const y = thisYear - 1 - Math.floor(rand() * 12);
      return { key: `theme:year:${y}`, title: `Best of ${y}`, ranks: () => best(all, (r) => facts.year[r] === y && facts.votes[r] >= 5_000 * seriesScale(r)) };
    }
    const d = pick([1970, 1980, 1990, 2000, 2010])!;
    return { key: `theme:decade:${d}`, title: `${d}s favourites`, ranks: () => best(all, (r) => facts.year[r] >= d && facts.year[r] < d + 10 && facts.votes[r] >= 20_000 * seriesScale(r)) };
  };
  const languageTheme = (l: number): Theme => ({
    key: `theme:lang:${idx.langs[l]}`,
    title: `Best in ${languageName(idx.langs[l])}`,
    ranks: () => best(all, (r) => idx.lang[r] === l && facts.votes[r] >= 1_000 * seriesScale(r)),
  });
  const allTime = (): Theme => ({ key: "theme:alltime", title: "All-time greats", ranks: () => best(all, (r) => facts.votes[r] >= 50_000 * seriesScale(r)) });

  const mine = args.genres.slice(0, 3);
  const others = args.catalogGenres.filter((g) => !mine.includes(g)).slice(0, 8);
  // Slots, in order: one of the viewer's genres, a year or a decade, their language (or a genre
  // from outside their taste), and a wildcard. Each slot tries a few themes until one has a row.
  const slots: (() => Theme | undefined)[] = [
    () => { const g = pick(mine.length ? mine : others); return g ? genreTheme(g) : undefined; },
    timeTheme,
    () => (args.langs.length && rand() < 0.7 ? languageTheme(args.langs[0]) : (() => { const g = pick(others); return g ? genreTheme(g) : undefined; })()),
    () => (rand() < 0.35 ? allTime() : (() => { const g = pick([...mine, ...others]); return g ? genreTheme(g) : undefined; })()),
  ];
  const out: { key: string; title: string; ranks: number[] }[] = [];
  const seen = new Set<string>();
  for (const slot of slots) {
    if (out.length >= count) break;
    for (let tries = 0; tries < 4; tries++) {
      const theme = slot();
      if (!theme || seen.has(theme.key)) continue;
      seen.add(theme.key);
      const ranks = theme.ranks();
      if (ranks.length >= minRow) { out.push({ key: theme.key, title: theme.title, ranks }); break; }
    }
  }
  return out;
}
