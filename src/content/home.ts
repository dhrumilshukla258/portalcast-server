// Home rows prepared per viewer (plan, Phase 2): the personal rows of the Discover/Home page,
// computed when the viewer's watching changes or the catalog does, not on every open.
//
// Rows (a row with fewer than MIN_ROW titles is left out; a title is in one row only; the
// versions of a title count once: only representative titles are offered, and every version of
// something watched is left out):
//   because   "Because you watched X": up to 3, one per recently watched title, its most
//             similar titles: shared genres, cast and director, collection, language
//   picks     "Top picks for you": titles scored by the viewer's genre, language and people
//             weights (what they watched, more recent counting more)
//   person    "More with <name>": the actor or director the viewer watched most (2+ titles)
//   popular   "Popular on this server": what other viewers here watched in the last 30 days
//   new       "Just added": what the provider added lately (content/homeThemes.ts)
//   trending  "Trending this week": TMDB's trending that this server has, else a vote-based chart
//   chart     what is popular in the viewer's countries: Netflix's Top 10, in cinemas, popular
//             on the country's streaming services, new episodes (content/homeCharts.ts)
//   theme     rows that change every day per viewer: "Horror classics", "Best of 2016", "Best in
//             Hindi", "All-time greats"... (content/homeThemes.ts). Top rated is no longer a
//             fixed row: Home should feel new, not the same chart every day (owner, 2026-10-22)
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
import { allViewerRows, recentProgress, isWatched, progressType, contentIdsOf, viewerGenerationOf, type ProgressRow } from "@/content/viewers";
import { titleFacts, onlineTrending, trendingStamp, justAdded, newEpisodes, trendingRanks, dailyThemes, dayNumber, nameKey, shuffled } from "@/content/homeThemes";
import { onProviderDatesChanged } from "@/content/providerDates";
import { chartsFor, chartsStamp, viewerCountries, type ChartList } from "@/content/homeCharts";

export type HomeType = "all" | "movie" | "series";
export interface HomeRow { key: string; kind: "because" | "picks" | "person" | "popular" | "trending" | "toprated" | "new" | "theme" | "chart" | "episodes"; title: string; ids: string[] }
export interface HomeRows {
  rows: HomeRow[];
  genreOrder: string[];
  builtAt: number;
  /** The previous rows, served while new ones are built: not to be kept as the current Home. */
  stale?: boolean;
}

const MIN_ROW = 6;
/** A chart from outside (a Top 10) overlaps a catalog only partly: shorter rows are fine. */
const MIN_CHART = 4;
const CHART_SIZE = 40;
const ROW_SIZE = 40;
const SIMILAR = 30;
const HALF_LIFE_DAYS = 30;
const TYPE_CODE = { movie: 1, series: 2 } as const;

/** A watched title, resolved to the card the catalog shows for it. */
interface Watched { rep: string; type: "movie" | "series"; title: string; weight: number; groupIds: string[]; row: any; at: number }

/** Decay: a title watched HALF_LIFE_DAYS ago counts half as much as one watched today. */
const recency = (r: ProgressRow) => Math.pow(0.5, (Date.now() - new Date(r.updatedAt).getTime()) / (HALF_LIFE_DAYS * 86_400_000));

/**
 * A title and its versions (catalog/cards.ts titleWithGroup), remembered until the catalog
 * changes: every Home build looks up the viewer's and every other viewer's watched titles, about
 * 2 ms each from the database, and they rarely change. Bounded: cleared past MEMO_MAX ids.
 */
const MEMO_MAX = 20_000;
let groupMemo: { key: string; map: Map<string, Promise<{ row: any; members: any[] } | null>> } = { key: "", map: new Map() };
function groupOf(id: string, idx: DiscoverIndex): Promise<{ row: any; members: any[] } | null> {
  const key = `${idx.builtAt}.${catalogGen}`;
  if (groupMemo.key !== key || groupMemo.map.size >= MEMO_MAX) groupMemo = { key, map: new Map() };
  let found = groupMemo.map.get(id);
  if (!found) {
    const memo = groupMemo;
    found = titleWithGroup(id);
    memo.map.set(id, found);
    found.catch(() => memo.map.delete(id));
  }
  return found;
}

/** The viewer's watched titles (newest first), each as its representative card. */
async function watchedTitles(rows: ProgressRow[], idx: DiscoverIndex): Promise<Watched[]> {
  const out: Watched[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isWatched(r)) continue;
    for (const id of contentIdsOf(r)) {
      const found = await groupOf(id, idx);
      if (!found) continue;
      const members = found.members as any[];
      const rep = members.find((m) => idx.rankOf.has(m.id))?.id;
      if (!rep || seen.has(rep)) break;
      seen.add(rep);
      const type = (progressType(r) ?? (found.row.type === "series" ? "series" : "movie")) as "movie" | "series";
      out.push({ rep, type, title: found.row.trimmedName || found.row.name, weight: (r.completed ? 1 : 0.6) * recency(r), groupIds: members.map((m) => m.id), row: found.row, at: new Date(r.updatedAt).getTime() });
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
  // A title is in one row only: Home never shows the same card twice (owner, 2026-10-22).
  const used = new Map<number, number>(); // rank -> rows it is in
  const take = (ranks: number[]) => ranks.filter((r) => !used.has(r)).slice(0, ROW_SIZE);
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

  // Online data, used by Top picks below and by the chart rows after (content/homeThemes.ts,
  // content/homeCharts.ts).
  const facts = await titleFacts(idx, catalogGen);
  const online = await onlineTrending().catch(() => null);
  // Charts keep watched titles (a chart); hidden and Not interested ones go.
  const chartOk = (r: number) => (want === 0 || idx.type[r] === want) && !hidden.has(idx.ids[r]) && !mine.has(idx.ids[r]);
  const countries = viewerCountries([...langW.entries()].map(([l, w]) => ({ code: idx.langs[l] ?? "", weight: w })));
  const resolve = (c: ChartList) => {
    const out: number[] = [];
    const seen = new Set<number>();
    const add = (r: number | undefined) => { if (r !== undefined && !seen.has(r) && chartOk(r)) { seen.add(r); out.push(r); } };
    for (const t of c.tmdb ?? []) add(facts.byTmdb.get(`${t.kind}:${t.id}`));
    for (const n of c.names ?? []) add(facts.byName.get(`${n.kind}|${nameKey(n.name)}`));
    return out;
  };
  const countryCharts = chartsFor(countries);
  // Popular right now, 0..1 per title (1 = the top of a list): TMDB's trending and the viewer's
  // countries' charts (owner, 2026-10-23: the online stats in the personal rows too).
  const popularity = new Map<number, number>();
  const addPopular = (ranks: number[]) => ranks.forEach((r, i) => { const v = 1 - i / ranks.length; if (v > (popularity.get(r) ?? 0)) popularity.set(r, v); });
  if (online) addPopular(trendingRanks(facts, online, type, chartOk));
  for (const c of countryCharts) addPopular(resolve(c));

  // Top picks: genre weights over each genre's titles, language and people on top, then what is
  // popular out there right now: up to +40 % of the best score, only for titles that already
  // match the viewer's taste (a chart never brings in something unrelated).
  if (watched.length) {
    const sc = new Scores(n);
    for (const [g, gw] of genreW) { const list = idx.postings.genre.get(g); if (list) for (let i = 0; i < list.length; i++) sc.add(list[i], gw); }
    for (const r of sc.touched) { const lw = langW.get(idx.lang[r]); if (lw) sc.s[r] += lw * 1.5; }
    const topPeople = [...personW.entries()].sort((a, b) => b[1].w - a[1].w).slice(0, 10);
    for (const [pid, e] of topPeople) for (const r of await ranksOfPerson(pid, idx)) sc.add(r, e.w * 2);
    if (popularity.size) {
      let best = 0;
      for (const r of sc.touched) if (sc.s[r] > best) best = sc.s[r];
      for (const [r, p] of popularity) if (sc.s[r] > 0) sc.s[r] += best * 0.4 * p;
    }
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
        const found = await groupOf(id, idx);
        const rep = found ? (found.members as any[]).find((m) => idx.rankOf.has(m.id))?.id : undefined;
        if (rep) { mine.add(idx.rankOf.get(rep)!); break; }
      }
    }
    for (const r of mine) votes.set(r, (votes.get(r) ?? 0) + 1);
  }
  const popular = take([...votes.entries()].filter(([r]) => ok(r)).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([r]) => r));
  if (popular.length >= MIN_ROW) rows.push({ key: "popular", kind: "popular", title: "Popular on this server", ids: commit(popular) });

  // Just added, Trending this week and today's themes (content/homeThemes.ts).
  // New episodes of series the viewer watched (watched titles are otherwise left out of Home):
  // one show is already worth a row.
  const episodesOk = (r: number) => !hidden.has(idx.ids[r]) && !mine.has(idx.ids[r]) && (want === 0 || idx.type[r] === want);
  const episodeRanks = take(newEpisodes(facts, watched.filter((w) => w.type === "series").map((w) => ({ rank: idx.rankOf.get(w.rep)!, at: w.at })), episodesOk));
  const episodesRow: HomeRow | null = episodeRanks.length ? { key: "episodes", kind: "episodes", title: "New episodes", ids: commit(episodeRanks) } : null;
  const fresh: HomeRow[] = [];
  const added = take(justAdded(idx, facts, ok));
  const newRow: HomeRow | null = added.length >= MIN_ROW ? { key: "new", kind: "new", title: "Just added", ids: commit(added) } : null;

  // Trending: a chart, so watched titles stay (chartOk above).
  const trendRows: HomeRow[] = [];
  if (online) {
    const ranks = take(trendingRanks(facts, online, type, chartOk));
    if (ranks.length >= MIN_ROW) trendRows.push({ key: `trending:${type}`, kind: "trending", title: "Trending this week", ids: commit(ranks) });
  }
  if (!trendRows.length) {
    // No TMDB key or no answer: the vote-based chart (recent titles, most voted first).
    const ch = await charts();
    for (const t of type === "all" ? (["movie", "series"] as const) : [type]) {
      const ranks = take(ch.trending[t].map((id) => idx.rankOf.get(id)).filter((r): r is number => r !== undefined && chartOk(r)));
      if (ranks.length >= MIN_ROW) trendRows.push({ key: `trending:${t}`, kind: "trending", title: type === "all" ? `Trending now · ${t === "movie" ? "Movies" : "Series"}` : "Trending now", ids: commit(ranks) });
    }
  }

  const typeKey = type === "all" ? "all" : type;
  const themes = dailyThemes({
    idx,
    facts,
    ok,
    seed: `${userId}:${profileId}:${dayNumber()}:${type}`,
    genres: genreOrder,
    langs: [...langW.entries()].sort((x, y) => y[1] - x[1]).map(([l]) => l),
    catalogGenres: (idx.facets as any)[typeKey]?.genres?.map((g: any) => g.value) ?? [],
    count: 4,
    minRow: MIN_ROW,
  }).map((t) => {
    const ranks = take(t.ranks);
    return ranks.length >= MIN_ROW ? ({ key: t.key, kind: "theme", title: t.title, ids: commit(ranks) } as HomeRow) : null;
  }).filter((r): r is HomeRow => r !== null);
  fresh.push(...themes);

  // What is popular out there in the viewer's countries (content/homeCharts.ts): two of the
  // ready charts a day, chosen per viewer and day. Charts keep watched titles (a chart).
  const chartRows: HomeRow[] = [];
  for (const c of shuffled(countryCharts, `${userId}:${profileId}:${dayNumber()}:${type}:charts`)) {
    if (chartRows.length >= 2) break;
    const ranks = take(resolve(c));
    if (ranks.length >= MIN_CHART) chartRows.push({ key: `chart:${c.key}`, kind: "chart", title: c.title, ids: commit(ranks) });
  }
  const [c1, c2] = chartRows;

  // Order: what the viewer watched leads Home, then what is new and popular, then today's themes
  // and charts between the other personal rows. The Movies and Series pages lead with trending.
  const byKind = (k: HomeRow["kind"]) => rows.filter((r) => r.kind === k);
  const [t1, t2, t3, t4] = themes;
  const ordered = type === "all"
    ? [episodesRow, ...byKind("because"), ...byKind("picks"), newRow, ...trendRows, c1, t1, ...byKind("person"), t2, c2, ...byKind("popular"), t3, t4]
    : [episodesRow, ...trendRows, c1, newRow, t1, ...byKind("because"), ...byKind("picks"), t2, c2, ...byKind("person"), t3, ...byKind("popular"), t4];
  rows.length = 0;
  for (const r of ordered) if (r) rows.push(r);

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
onProviderDatesChanged(markHomeStale);

/** The title facts (content/homeThemes.ts) built in the background after start-up (server.ts),
 *  so the first Home open after a restart does not wait seconds for them. Local reads only. */
export function primeHomeFacts(): void {
  getDiscoverIndex()
    .then((idx) => titleFacts(idx, catalogGen))
    .catch((e) => logger.warn(`[home] title facts warm-up failed (built on the first open): ${e?.message ?? e}`));
}

/**
 * Everything a viewer's Home depends on: their history and what others watched, the catalog,
 * Not interested, the day (themes), TMDB's trending and the charts. The rows are rebuilt when it
 * changes, and the apps' cached Home is replaced (X-Home-Version, infra/answerVersion.ts).
 */
export function homeVersionOf(userId: number, profileId: number): string {
  return `${viewerGenerationOf(userId, profileId)}.${catalogGen}.${notInterestedGen()}.${dayNumber()}.${trendingStamp()}.${chartsStamp()}`;
}

/**
 * The viewer's rows: current ones from the cache, else built now the first time, else the
 * previous ones while new ones are built in the background (Home never waits on a rebuild).
 */
export async function homeRows(userId: number, profileId: number, type: HomeType): Promise<HomeRows> {
  const key = `${userId}:${profileId}:${type}`;
  // The day and TMDB's trending are part of it: themes change at midnight, trending every 6 h.
  const gen = homeVersionOf(userId, profileId);
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
    return { ...have.value, stale: true };
  }
  return job;
}
