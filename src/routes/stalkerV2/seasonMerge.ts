// A show the provider lists one season at a time, served as one show (content/seasonParts.ts).
//
// Wraps the existing /api/v2/series and /api/v2/movies handlers; nothing else changes and the
// apps need no change:
// - seasons (`series?movieId=X`): when X's group has season parts in X's language, the season
//   lists of those parts are fetched (each through the unchanged handler, so its caching and
//   provider rules apply) and merged; a season's id names its parts ("m:7:515872.1~574273.7");
// - episodes (`series?movieId=X&seasonId=m:..`): one part's list, or the copies merged per
//   episode (best quality first, gaps filled from the others), paged as before;
// - an episode's file (`movies?...&seasonId=m:..&episodeId=E` or the same on `series`): asked
//   of the part the episode came from.
// A title whose group has no season parts, and every request without an "m:" id, goes to the
// handler as before.

import type { Request, ResponseToolkit, ServerRoute } from "@hapi/hapi";
import { Op } from "sequelize";
import { ContentMeta } from "@/models/ContentMeta";
import { LOCAL_CATEGORY } from "@/content/metaEnrichment";
import { categoryNames } from "@/content/versionLabel";
import { getHiddenContentKeySet } from "@/content/overrides";
import { rememberSeasonNumbers } from "@/content/tmdbEpisodes";
import { seasonMarkerOf, audioLanguageOf, qualityRankOf, mergeSeasonLists, mergeEpisodeLists, decodeSeasonId, type PartSeasons, type SeasonSource } from "@/content/seasonParts";
import { getActiveProfileId } from "./shared";
import { logger } from "@/infra/logger";
import { initialConfig } from "@/config/server";

type Handler = (request: Request, h: ResponseToolkit) => any;

interface Part { id: string; name: string; quality: number; opened: boolean }

const EPISODE_PAGE = 14; // what the provider pages episodes by (series.ts itemsPerApiPage)
const MAX_EPISODE_PAGES = 80;
const PARTS_TTL_MS = 60_000;
const partsMemo = new Map<string, { at: number; parts: Part[] | null }>();
// Which part an episode came from, learned when a merged season's episodes were listed.
const episodeSource = new Map<string, SeasonSource>();
const MAX_EPISODE_SOURCES = 20_000;

/** The request with other query values, for a call to the wrapped handler. */
function withQuery(request: Request, query: Record<string, any>): Request {
  return Object.create(request, { query: { value: query, enumerable: true, writable: true } });
}

/** A handler answer with a data list (not an error response or a redirect). */
function dataOf(r: any): any[] | null {
  if (!r || typeof r !== "object" || typeof r.code === "function" || !Array.isArray(r.data)) return null;
  return r.data;
}

/**
 * The parts of X's show in X's language, X first; null when there is nothing to do (no season
 * parts in its group). Hidden parts are left out.
 */
export async function seasonPartsOf(movieId: string): Promise<Part[] | null> {
  const memo = partsMemo.get(movieId);
  if (memo && Date.now() - memo.at < PARTS_TTL_MS) return memo.parts;
  let parts: Part[] | null = null;
  try {
    parts = await findParts(movieId);
  } catch (e: any) {
    logger.warn(`[seasons] parts of series ${movieId}: ${e?.message ?? e}`);
  }
  if (partsMemo.size > 2000) partsMemo.clear();
  partsMemo.set(movieId, { at: Date.now(), parts });
  return parts;
}

async function findParts(movieId: string): Promise<Part[] | null> {
  const row = (await ContentMeta.findByPk(`series_${movieId}`, { attributes: ["id", "name", "groupKey", "portalCategoryId"], raw: true })) as any;
  if (!row?.groupKey || row.portalCategoryId === LOCAL_CATEGORY) return null;
  const members = (await ContentMeta.findAll({
    where: { groupKey: row.groupKey, type: "series", portalCategoryId: { [Op.ne]: LOCAL_CATEGORY } },
    attributes: ["id", "name", "portalCategoryId"],
    raw: true,
  })) as any[];
  if (!members.some((m) => seasonMarkerOf(m.name))) return null;
  const hidden = await getHiddenContentKeySet();
  const names = await categoryNames(await getActiveProfileId());
  const catName = (id: any) => names.series.get(String(id)) ?? names.movie.get(String(id));
  const lang = new Map<string, string>(members.map((m) => [m.id, audioLanguageOf(m.name, catName(m.portalCategoryId))]));
  // A part of unknown language belongs to the show's only known language, if it has one.
  const known = new Set([...lang.values()].filter(Boolean));
  const langOf = (id: string) => lang.get(id) || (known.size === 1 ? [...known][0] : "");
  const want = langOf(row.id);
  const parts = members
    .filter((m) => m.id === row.id || (!hidden.has(m.id) && langOf(m.id) === want))
    .map((m) => ({ id: String(m.id).replace(/^series_/, ""), name: m.name, quality: qualityRankOf(m.name), opened: m.id === row.id }))
    .sort((a, b) => Number(b.opened) - Number(a.opened));
  // One part alone is served this way too when its name names its season ("Coke Studio India
  // Season 03" filed by the provider as season 1 is Season 3).
  return parts.length > 1 || seasonMarkerOf(row.name) ? parts : null;
}

/** Runs [fn] over [items] with at most [limit] at a time, keeping order. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

function listResponse(data: any[], page: number, total: number) {
  return { success: true, page, pageAtaTime: 1, total_items: total, actual_length: EPISODE_PAGE, total_loaded: data.length, data, errors: false, isPortal: initialConfig.providerType === "stalker" };
}

async function mergedSeasons(inner: Handler, request: Request, h: ResponseToolkit, parts: Part[]) {
  const q = request.query as any;
  const lists = await pool(parts, 3, async (p) => {
    const r = await inner(withQuery(request, { ...q, movieId: p.id, page: 1 }), h);
    return { ...p, seasons: (dataOf(r) ?? []).filter((s: any) => !s?.is_episode) } as PartSeasons;
  });
  const merged = mergeSeasonLists(lists.filter((l) => l.seasons.length > 0));
  if (merged.length === 0) return null;
  rememberSeasonNumbers(merged);
  return listResponse(merged, 1, merged.length);
}

/** Every episode of one part's season (all pages), through the wrapped handler. */
async function allEpisodes(inner: Handler, request: Request, h: ResponseToolkit, src: SeasonSource, n: number): Promise<any[]> {
  const q = request.query as any;
  const out: any[] = [];
  for (let page = 1; page <= MAX_EPISODE_PAGES; page++) {
    const r = await inner(withQuery(request, { ...q, movieId: src.part, seasonId: src.season, seasonNumber: n, page }), h);
    const data = dataOf(r);
    if (!data || data.length === 0) break;
    out.push(...data);
    const total = Number(r.total_items) || 0;
    if (out.length >= total || data.length < EPISODE_PAGE) break;
  }
  return out;
}

function rememberSource(episodes: any[], src: SeasonSource) {
  for (const e of episodes) {
    if (e?.id == null) continue;
    if (episodeSource.size >= MAX_EPISODE_SOURCES) episodeSource.delete(episodeSource.keys().next().value as string);
    episodeSource.set(String(e.id), src);
  }
}

async function mergedEpisodes(inner: Handler, request: Request, h: ResponseToolkit, n: number, sources: SeasonSource[], mergedId: string) {
  const q = request.query as any;
  const page = Math.max(1, Number(q.page) || 1);
  const tag = (items: any[]) => items.map((e) => ({ ...e, season_id: mergedId }));
  if (sources.length === 1) {
    const r = await inner(withQuery(request, { ...q, movieId: sources[0].part, seasonId: sources[0].season, seasonNumber: n }), h);
    const data = dataOf(r);
    if (!data) return r;
    rememberSource(data, sources[0]);
    return { ...r, data: tag(data) };
  }
  const names = new Map<string, string>(((await ContentMeta.findAll({
    where: { id: sources.map((s) => `series_${s.part}`) }, attributes: ["id", "name"], raw: true,
  })) as any[]).map((r) => [String(r.id).replace(/^series_/, ""), r.name]));
  const copies = await pool(sources, 2, async (src) => {
    const items = await allEpisodes(inner, request, h, src, n);
    rememberSource(items, src);
    return { quality: qualityRankOf(names.get(src.part) ?? ""), items };
  });
  const all = mergeEpisodeLists(copies);
  return listResponse(tag(all.slice((page - 1) * EPISODE_PAGE, page * EPISODE_PAGE)), page, all.length);
}

/** An episode's file: from the part it came from (known, else each part in turn). */
async function episodeFile(inner: Handler, request: Request, h: ResponseToolkit, sources: SeasonSource[]) {
  const q = request.query as any;
  const known = episodeSource.get(String(q.episodeId));
  const order = known ? [known, ...sources.filter((s) => s.part !== known.part || s.season !== known.season)] : sources;
  let last: any = null;
  for (const src of order) {
    last = await inner(withQuery(request, { ...q, movieId: src.part, seasonId: src.season }), h);
    const data = dataOf(last);
    if (data && data.length > 0) return last;
  }
  return last;
}

/** /api/v2/series with season parts merged (see the top of this file). */
export function mergeSeriesHandler(inner: Handler): Handler {
  return async (request, h) => {
    const q = request.query as any;
    const movieId = String(q.movieId ?? "0");
    if (!/^\d+$/.test(movieId) || movieId === "0" || q.search) return inner(request, h);
    try {
      const dec = decodeSeasonId(q.seasonId);
      if (dec) {
        if (Number(q.episodeId) > 0) return await episodeFile(inner, request, h, dec.sources);
        return await mergedEpisodes(inner, request, h, dec.n, dec.sources, String(q.seasonId));
      }
      const noSeason = !q.seasonId || String(q.seasonId) === "0";
      if (noSeason && !(Number(q.episodeId) > 0)) {
        const parts = await seasonPartsOf(movieId);
        if (parts) {
          const merged = await mergedSeasons(inner, request, h, parts);
          if (merged) return merged;
        }
      }
    } catch (e: any) {
      logger.warn(`[seasons] merged answer for series ${movieId} failed, plain one instead: ${e?.message ?? e}`);
    }
    return inner(request, h);
  };
}

/** /api/v2/movies: an episode's file asked with a merged season's id. */
export function mergeMoviesHandler(inner: Handler): Handler {
  return async (request, h) => {
    const q = request.query as any;
    const dec = decodeSeasonId(q.seasonId);
    if (!dec) return inner(request, h);
    if (Number(q.episodeId) > 0) return episodeFile(inner, request, h, dec.sources);
    // A season's episodes asked on the movies route: the first part's, as the plain route would.
    return inner(withQuery(request, { ...q, movieId: dec.sources[0].part, seasonId: dec.sources[0].season }), h);
  };
}

/** Wraps the route at [path] in [routes] with [wrap]. */
export function wrapRoute(routes: ServerRoute[], path: string, wrap: (inner: Handler) => Handler): void {
  const route = routes.find((r) => r.path === path && r.method === "GET");
  if (!route || typeof route.handler !== "function") throw new Error(`season merge: route ${path} not found`);
  route.handler = wrap(route.handler as Handler) as any;
}
