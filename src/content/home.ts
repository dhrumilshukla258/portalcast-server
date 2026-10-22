// Home rows prepared per viewer (plan, Phase 2): the personal rows of the Discover/Home page,
// computed when the viewer's watching changes or the catalog does, not on every open.
//
// Rows (a row with fewer than MIN_ROW titles is left out; a title is in at most two rows; the
// versions of a title count once: only representative titles are offered, and every version of
// something watched is left out):
//   because   "Because you watched X": up to 3, one per recently watched title, its most
//             similar titles: shared genres, cast and director, collection, language
//   picks     "Top picks for you": titles scored by the viewer's genre, language and people
//             weights (what they watched, more recent counting more)
//   person    "More with <name>": the actor or director the viewer watched most (2+ titles)
//   popular   "Popular on this server": what other viewers here watched in the last 30 days
// plus `genreOrder`: the viewer's genres, most watched first, for the genre rows the apps page
// through themselves. Continue Watching stays where it is (the apps build it from progress).
//
// Inputs, all in memory: the viewer store (content/viewers.ts), Discover's index (ranks,
// genres, languages of representative titles), and for the few watched titles and their people
// the snapshot or the database (catalog/cards.ts). A viewer's rows are cached until their
// progress or the catalog changes; a stale answer is served while new rows are built, so a
// Home open never waits for more than the first build.

import { hiddenFor, notInterestedGen } from "@/content/notInterested";
import { QueryTypes } from "sequelize";
import { sequelize } from "@/db";
import { getDiscoverIndex, type DiscoverIndex } from "@/content/discoverIndex";
import { getHiddenContentKeySet } from "@/content/overrides";
import { titleKeyOf } from "@/content/people";
import { logger } from "@/infra/logger";
import { titleWithGroup, titlePeople, personTitles } from "@/content/catalog/cards";
import { allViewerRows, recentProgress, isWatched, progressType, contentIdsOf, viewerGeneration, type ProgressRow } from "@/content/viewers";

export type HomeType = "all" | "movie" | "series";
export interface HomeRow { key: string; kind: "because" | "picks" | "person" | "popular" | "trending" | "toprated"; title: string; ids: string[] }
export interface HomeRows { rows: HomeRow[]; genreOrder: string[]; builtAt: number }

const MIN_ROW = 6;
const CHART_SIZE = 40;
const ROW_SIZE = 40;
const SIMILAR = 30;
const HALF_LIFE_DAYS = 30;
const TYPE_CODE = { movie: 1, series: 2 } as const;

/** A watched title, resolved to the card the catalog shows for it. */
interface Watched { rep: string; type: "movie" | "series"; title: string; weight: number; groupIds: string[]; row: any }

/** Decay: a title watched HALF_LIFE_DAYS ago counts half as much as one watched today. */
const recency = (r: ProgressRow) => Math.pow(0.5, (Date.now() - new Date(r.updatedAt).getTime()) / (HALF_LIFE_DAYS * 86_400_000));

/** The viewer's watched titles (newest first), each as its representative card. */
async function watchedTitles(rows: ProgressRow[], idx: DiscoverIndex): Promise<Watched[]> {
  const out: Watched[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isWatched(r)) continue;
    for (const id of contentIdsOf(r)) {
      const found = await titleWithGroup(id);
      if (!found) continue;
      const members = found.members as any[];
      const rep = members.find((m) => idx.rankOf.has(m.id))?.id;
      if (!rep || seen.has(rep)) break;
      seen.add(rep);
      const type = (progressType(r) ?? (found.row.type === "series" ? "series" : "movie")) as "movie" | "series";
      out.push({ rep, type, title: found.row.trimmedName || found.row.name, weight: (r.completed ? 1 : 0.6) * recency(r), groupIds: members.map((m) => m.id), row: found.row });
      break;
    }
  }
  return out;
}

/** Scores per rank (Float64Array over the index) with the ranks touched, reset cheaply. */
class Scores {
  readonly s: Float64Array;
  readonly touched: number[] = [];
  constructor(n: number) { this.s = new Float64Array(n); }
  add(rank: number, v: number) { if (this.s[rank] === 0) this.touched.push(rank); this.s[rank] += v; }
  /** Best `limit` ranks passing `keep`, score descending then newest first. */
  top(limit: number, keep: (rank: number) => boolean): number[] {
    return this.touched.filter((r) => this.s[r] > 0 && keep(r)).sort((a, b) => this.s[b] - this.s[a] || a - b).slice(0, limit);
  }
}

/** People who define a title: its directors and creators, and the first five billed cast. */
async function keyPeople(row: any): Promise<{ id: number; name: string; lead: number }[]> {
  const people = await titlePeople([row.id, titleKeyOf(row)]);
  const out: { id: number; name: string; lead: number }[] = [];
  let cast = 0;
  for (const p of people) {
    if (p.kind === "director" || p.kind === "creator") out.push({ id: p.id, name: p.name, lead: 5 });
    else if (p.kind === "cast" && cast++ < 5) out.push({ id: p.id, name: p.name, lead: 4 });
  }
  return out;
}

/** Representative titles of a person, as index ranks. */
async function ranksOfPerson(personId: number, idx: DiscoverIndex): Promise<number[]> {
  const titles = await personTitles(personId);
  const out: number[] = [];
  for (const t of titles) { const r = idx.rankOf.get(t.row.id); if (r !== undefined) out.push(r); }
  return out;
}

/**
 * Titles like the one at rank r0: shared genres (3 each), shared people (a director or creator
 * 5, one of the first five billed cast 4), same language (2). Used by "Because you watched X"
 * and the detail page's More Like This.
 */
async function similarScores(idx: DiscoverIndex, r0: number, people: { id: number; lead: number }[], genresOfRank: (rank: number) => string[]): Promise<Scores> {
  const sc = new Scores(idx.ids.length);
  for (const g of genresOfRank(r0)) { const list = idx.postings.genre.get(g)!; for (let i = 0; i < list.length; i++) sc.add(list[i], 3); }
  for (const p of people) for (const r of await ranksOfPerson(p.id, idx)) sc.add(r, p.lead);
  const lang0 = idx.lang[r0];
  if (lang0 >= 0) for (const r of sc.touched) if (idx.lang[r] === lang0) sc.s[r] += 2;
  return sc;
}

/** The genres of a rank (each genre's postings, binary search). */
function genresAt(idx: DiscoverIndex, rank: number): string[] {
  const out: string[] = [];
  for (const [value, list] of idx.postings.genre) {
    let lo = 0, hi = list.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] < rank) lo = m + 1; else hi = m; }
    if (lo < list.length && list[lo] === rank) out.push(value);
  }
  return out;
}

/**
 * More Like This for a title (any version's id): up to `limit` representative titles of the
 * same type, most similar first, never a version of the title itself, nothing hidden. Empty
 * when the title is not in Discover's index (not enriched yet).
 */
export async function similarTitles(id: string, limit = 20): Promise<string[]> {
  const idx = await getDiscoverIndex();
  const found = await titleWithGroup(id);
  if (!found) return [];
  const members = found.members as any[];
  const rep = members.find((m) => idx.rankOf.has(m.id))?.id;
  if (!rep) return [];
  const r0 = idx.rankOf.get(rep)!;
  const hidden = await getHiddenContentKeySet();
  const own = new Set(members.map((m) => idx.rankOf.get(m.id)).filter((r) => r !== undefined));
  const sc = await similarScores(idx, r0, await keyPeople(found.row), (rank) => genresAt(idx, rank));
  return sc.top(limit, (r) => !own.has(r) && idx.type[r] === idx.type[r0] && !hidden.has(idx.ids[r]) && sc.s[r] >= 6).map((r) => idx.ids[r]);
}

// ── charts: the same for every viewer, made once per catalog change ────────────

interface Charts { trending: Record<"movie" | "series", string[]>; topRated: Record<"movie" | "series", string[]> }
let chartsCache: { gen: number; value: Promise<Charts> } | null = null;

/**
 * Trending now: titles first shown in the last six months, most voted first (votes stand in for
 * popularity: no trending data comes from TMDB). Top rated: IMDb's rating among well-known
 * titles (50k votes for movies, 20k for series), TMDB's when too few have one. Representative
 * titles only (one card per title).
 */
function charts(): Promise<Charts> {
  if (chartsCache && chartsCache.gen === catalogGen) return chartsCache.value;
  const value = (async () => {
    // Every copy with a TMDB id, folded per title (type + TMDB id): versions of one title can
    // sit in separate groups ("Avatar ... HD", "... Eng Dub"), and a rating is often stored on
    // another version than the representative one. One card per title: its representative copy.
    const copies = (await sequelize.query(
      "SELECT id, type, tmdbId, isRepresentative, premiered, imdbRating, imdbVotes, rating, ratingCount FROM content_meta WHERE tmdbId IS NOT NULL",
      { type: QueryTypes.SELECT },
    )) as any[];
    interface Title { type: "movie" | "series"; rep: string | null; premiered: number; imdbRating: number; imdbVotes: number; rating: number; ratingCount: number }
    const titles = new Map<string, Title>();
    for (const c of copies) {
      const type = c.type === "series" ? "series" : "movie";
      const key = `${type}:${c.tmdbId}`;
      let t = titles.get(key);
      if (!t) titles.set(key, (t = { type, rep: null, premiered: NaN, imdbRating: 0, imdbVotes: 0, rating: 0, ratingCount: 0 }));
      if (Number(c.isRepresentative) && (!t.rep || String(c.id) < t.rep)) t.rep = String(c.id);
      const p = Date.parse(String(c.premiered ?? ""));
      if (Number.isFinite(p) && !(p >= t.premiered)) t.premiered = Number.isFinite(t.premiered) ? Math.min(t.premiered, p) : p;
      if ((Number(c.imdbVotes) || 0) > t.imdbVotes) { t.imdbVotes = Number(c.imdbVotes); t.imdbRating = Number(c.imdbRating) || 0; }
      if ((Number(c.ratingCount) || 0) > t.ratingCount) { t.ratingCount = Number(c.ratingCount); t.rating = Number(c.rating) || 0; }
    }
    const now = Date.now(), since = now - 183 * 86_400_000;
    const votes = (t: Title) => Math.max(t.imdbVotes, t.ratingCount);
    const out: Charts = { trending: { movie: [], series: [] }, topRated: { movie: [], series: [] } };
    for (const type of ["movie", "series"] as const) {
      const mine = [...titles.values()].filter((t) => t.type === type && t.rep);
      out.trending[type] = mine
        .filter((t) => t.premiered >= since && t.premiered <= now + 86_400_000 && votes(t) >= 20)
        .sort((a, b) => votes(b) - votes(a) || a.rep!.localeCompare(b.rep!))
        .slice(0, CHART_SIZE).map((t) => t.rep!);
      const minVotes = type === "series" ? 20_000 : 50_000;
      let top = mine.filter((t) => t.imdbRating > 0 && t.imdbVotes >= minVotes)
        .sort((a, b) => b.imdbRating - a.imdbRating || b.imdbVotes - a.imdbVotes);
      if (top.length < 12) {
        top = mine.filter((t) => t.rating > 0 && t.ratingCount >= 1000)
          .sort((a, b) => b.rating - a.rating || b.ratingCount - a.ratingCount);
      }
      out.topRated[type] = top.slice(0, CHART_SIZE).map((t) => t.rep!);
    }
    return out;
  })();
  chartsCache = { gen: catalogGen, value };
  value.catch(() => { if (chartsCache?.value === value) chartsCache = null; });
  return value;
}

export async function buildHomeRows(userId: number, profileId: number, type: HomeType): Promise<HomeRows> {
  const idx = await getDiscoverIndex();
  const hidden = await getHiddenContentKeySet();
  // The viewer's "Not interested" titles are out too.
  const mine = await hiddenFor(userId);
  const progress = await recentProgress(userId, profileId, 200);
  const watched = (await watchedTitles(progress, idx)).filter((w) => type === "all" || w.type === type);
  const n = idx.ids.length;
  const want = type === "all" ? 0 : TYPE_CODE[type];
  // Every version of anything watched is out, so is anything hidden.
  const excluded = new Set<number>();
  for (const w of watched) for (const id of w.groupIds) { const r = idx.rankOf.get(id); if (r !== undefined) excluded.add(r); }
  const ok = (r: number) => (want === 0 || idx.type[r] === want) && !excluded.has(r) && !hidden.has(idx.ids[r]) && !mine.has(idx.ids[r]);
  const used = new Map<number, number>(); // rank -> rows it is in (at most two)
  const take = (ranks: number[]) => ranks.filter((r) => (used.get(r) ?? 0) < 2).slice(0, ROW_SIZE);
  const commit = (ranks: number[]) => { for (const r of ranks) used.set(r, (used.get(r) ?? 0) + 1); return ranks.map((r) => idx.ids[r]); };
  const rows: HomeRow[] = [];

  // Taste weights.
  const genreW = new Map<string, number>(), langW = new Map<number, number>(), personW = new Map<number, { w: number; name: string; count: number }>();
  const genresOf = new Map<number, string[]>();
  const genresOfRank = (rank: number) => {
    let g = genresOf.get(rank);
    if (!g) genresOf.set(rank, (g = genresAt(idx, rank)));
    return g;
  };
  const peopleOfWatched = new Map<string, { id: number; name: string; lead: number }[]>();
  for (const w of watched) {
    const r = idx.rankOf.get(w.rep)!;
    for (const g of genresOfRank(r)) genreW.set(g, (genreW.get(g) ?? 0) + w.weight);
    if (idx.lang[r] >= 0) langW.set(idx.lang[r], (langW.get(idx.lang[r]) ?? 0) + w.weight);
    const ppl = await keyPeople(w.row);
    peopleOfWatched.set(w.rep, ppl);
    for (const p of ppl) { const e = personW.get(p.id) ?? { w: 0, name: p.name, count: 0 }; e.w += w.weight * (p.lead / 5); e.count++; personW.set(p.id, e); }
  }
  const genreOrder = [...genreW.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);

  // Because you watched X: the 3 most recent watched titles, each its most similar titles.
  for (const w of watched.slice(0, 3)) {
    const r0 = idx.rankOf.get(w.rep)!;
    const sc = await similarScores(idx, r0, peopleOfWatched.get(w.rep) ?? [], genresOfRank);
    const sameType = (r: number) => idx.type[r] === idx.type[r0];
    const ranks = take(sc.top(SIMILAR * 2, (r) => ok(r) && sameType(r) && sc.s[r] >= 6));
    if (ranks.length >= MIN_ROW) rows.push({ key: `because:${w.rep}`, kind: "because", title: `Because you watched ${w.title}`, ids: commit(ranks.slice(0, SIMILAR)) });
  }

  // Top picks: genre weights over each genre's titles, language and people on top.
  if (watched.length) {
    const sc = new Scores(n);
    for (const [g, gw] of genreW) { const list = idx.postings.genre.get(g); if (list) for (let i = 0; i < list.length; i++) sc.add(list[i], gw); }
    for (const r of sc.touched) { const lw = langW.get(idx.lang[r]); if (lw) sc.s[r] += lw * 1.5; }
    const topPeople = [...personW.entries()].sort((a, b) => b[1].w - a[1].w).slice(0, 10);
    for (const [pid, e] of topPeople) for (const r of await ranksOfPerson(pid, idx)) sc.add(r, e.w * 2);
    const ranks = take(sc.top(ROW_SIZE * 2, ok));
    if (ranks.length >= MIN_ROW) rows.push({ key: "picks", kind: "picks", title: "Top picks for you", ids: commit(ranks) });

    // More with <person>: watched in two titles or more, the most weight.
    const fav = [...personW.entries()].filter(([, e]) => e.count >= 2).sort((a, b) => b[1].w - a[1].w)[0];
    if (fav) {
      const ranks2 = take((await ranksOfPerson(fav[0], idx)).filter(ok).sort((a, b) => a - b));
      if (ranks2.length >= MIN_ROW) rows.push({ key: `person:${fav[0]}`, kind: "person", title: `More with ${fav[1].name}`, ids: commit(ranks2) });
    }
  }

  // Popular on this server: other viewers' watching in the last 30 days, one vote per viewer.
  const votes = new Map<number, number>();
  const since = Date.now() - 30 * 86_400_000;
  for (const v of allViewerRows()) {
    if (v.userId === userId && v.profileId === profileId) continue;
    const mine = new Set<number>();
    for (const r of v.rows) {
      if (new Date(r.updatedAt).getTime() < since || !isWatched(r)) continue;
      for (const id of contentIdsOf(r)) {
        const found = await titleWithGroup(id);
        const rep = found ? (found.members as any[]).find((m) => idx.rankOf.has(m.id))?.id : undefined;
        if (rep) { mine.add(idx.rankOf.get(rep)!); break; }
      }
    }
    for (const r of mine) votes.set(r, (votes.get(r) ?? 0) + 1);
  }
  const popular = take([...votes.entries()].filter(([r]) => ok(r)).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([r]) => r));
  if (popular.length >= MIN_ROW) rows.push({ key: "popular", kind: "popular", title: "Popular on this server", ids: commit(popular) });

  // Trending now and Top rated (the same for everyone): first on the Movies and Series pages,
  // after the personal rows on Home. Hidden titles are left out; watched ones stay (a chart).
  const ch = await charts();
  const chartRows: HomeRow[] = [];
  const chart = (ids: string[]) => ids.filter((id) => !hidden.has(id) && !mine.has(id)).slice(0, ROW_SIZE);
  if (type === "all") {
    for (const t of ["movie", "series"] as const) {
      const ids = chart(ch.trending[t]);
      if (ids.length >= MIN_ROW) chartRows.push({ key: `trending:${t}`, kind: "trending", title: `Trending now · ${t === "movie" ? "Movies" : "Series"}`, ids });
    }
    rows.push(...chartRows);
  } else {
    const trending = chart(ch.trending[type]), top = chart(ch.topRated[type]);
    if (trending.length >= MIN_ROW) chartRows.push({ key: `trending:${type}`, kind: "trending", title: "Trending now", ids: trending });
    if (top.length >= MIN_ROW) chartRows.push({ key: `toprated:${type}`, kind: "toprated", title: "Top rated", ids: top });
    rows.unshift(...chartRows);
  }

  return { rows, genreOrder, builtAt: Date.now() };
}

// ── cache: per viewer and type, rebuilt when their progress or the catalog changes ──

interface Entry { gen: string; value: HomeRows }
const cache = new Map<string, Entry>();
const building = new Map<string, Promise<HomeRows>>();
let catalogGen = 0;

/** The catalog changed (enrichment, content-manager edits): every viewer's rows are stale. */
export function markHomeStale(): void {
  catalogGen++;
}

/**
 * The viewer's rows: current ones from the cache, else built now the first time, else the
 * previous ones while new ones are built in the background (Home never waits on a rebuild).
 */
export async function homeRows(userId: number, profileId: number, type: HomeType): Promise<HomeRows> {
  const key = `${userId}:${profileId}:${type}`;
  const gen = `${viewerGeneration()}.${catalogGen}.${notInterestedGen()}`;
  const have = cache.get(key);
  if (have && have.gen === gen) return have.value;
  let job = building.get(key);
  if (!job) {
    const t0 = Date.now();
    job = buildHomeRows(userId, profileId, type)
      .then((value) => {
        cache.set(key, { gen, value });
        logger.debug(`[home] rows for ${key}: ${value.rows.length} rows in ${Date.now() - t0} ms`);
        return value;
      })
      .finally(() => building.delete(key));
    building.set(key, job);
  }
  if (have) {
    job.catch((e) => logger.warn(`[home] rows for ${key} failed (previous kept): ${e?.message ?? e}`));
    return have.value;
  }
  return job;
}
