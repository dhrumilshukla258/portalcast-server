import { Op } from "sequelize";
import { XtreamCache } from "@/models/XtreamCache";
import { SystemConfig } from "@/models/SystemConfig";
import { logger } from "@/infra/logger";
import { initialConfig, seriesFlag } from "@/config/server";
import { serverManager } from "@/serverManager";
import { readGenres, upsertGenre, deleteGenre } from "@/infra/storage";

const TTL_MS = 24 * 60 * 60 * 1000;

// ── In-process read cache ────────────────────────────────────────────────────
// Every xtreamCache.get/set round-trips SQLite plus a full JSON.parse/stringify of
// the value (categories can be thousands of items). This process is the only writer
// to the table, so a short-TTL in-memory cache of the raw JSON string is safe: it
// still parses fresh on every read (no shared mutable object references handed to
// callers — same behavior as before) but skips the DB hit and read query entirely
// for anything requested again within the window. Bursts of near-simultaneous reads
// of the same key (multiple genres in a listing, several users browsing the same
// category) are the common case this targets.
const MEM_TTL_MS = 30 * 1000;
const MEM_MAX_ENTRIES = 3000;
const memRaw = new Map<string, { value: string; expiresAt: Date; cachedAt: number }>();

function memGet(key: string): { value: string; expiresAt: Date } | undefined {
  const entry = memRaw.get(key);
  if (!entry) return undefined;
  if (entry.cachedAt + MEM_TTL_MS < Date.now()) {
    memRaw.delete(key);
    return undefined;
  }
  return entry;
}

function memSet(key: string, value: string, expiresAt: Date): void {
  if (!memRaw.has(key) && memRaw.size >= MEM_MAX_ENTRIES) {
    const oldestKey = memRaw.keys().next().value;
    if (oldestKey !== undefined) memRaw.delete(oldestKey);
  }
  memRaw.set(key, { value, expiresAt, cachedAt: Date.now() });
}

function memDelete(key: string): void {
  memRaw.delete(key);
}

export const xtreamCache = {
  async get<T>(key: string): Promise<T | undefined> {
    const hit = memGet(key);
    if (hit) {
      try {
        return JSON.parse(hit.value) as T;
      } catch {
        return undefined;
      }
    }
    const row = await XtreamCache.findOne({ where: { key } });
    if (!row) return undefined;
    memSet(key, row.value, row.expiresAt);
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  },

  // Batched read for N lookups in a single round trip — use in place of N individual
  // `get()` calls in a loop/Promise.all (e.g. enriching a page of catalog items).
  async getMany<T>(keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    if (keys.length === 0) return result;

    const misses: string[] = [];
    for (const key of keys) {
      const hit = memGet(key);
      if (!hit) { misses.push(key); continue; }
      try {
        result.set(key, JSON.parse(hit.value) as T);
      } catch {
        // skip unparsable entries, same as get()
      }
    }
    if (misses.length === 0) return result;

    const rows = await XtreamCache.findAll({ where: { key: { [Op.in]: misses } } });
    for (const row of rows) {
      memSet(row.key, row.value, row.expiresAt);
      try {
        result.set(row.key, JSON.parse(row.value) as T);
      } catch {
        // skip unparsable entries, same as get()
      }
    }
    return result;
  },

  async getWithStaleness<T>(key: string): Promise<{ value: T | undefined; isStale: boolean }> {
    const hit = memGet(key);
    if (hit) {
      const isStale = hit.expiresAt < new Date();
      try {
        return { value: JSON.parse(hit.value) as T, isStale };
      } catch {
        return { value: undefined, isStale: true };
      }
    }
    const row = await XtreamCache.findOne({ where: { key } });
    if (!row) return { value: undefined, isStale: true };
    memSet(key, row.value, row.expiresAt);
    const isStale = row.expiresAt < new Date();
    try {
      return { value: JSON.parse(row.value) as T, isStale };
    } catch {
      return { value: undefined, isStale: true };
    }
  },

  async set(key: string, value: any): Promise<void> {
    const expiresAt = new Date(Date.now() + TTL_MS);
    const raw = JSON.stringify(value);
    await XtreamCache.upsert({ key, value: raw, expiresAt });
    memSet(key, raw, expiresAt);
  },

  async delete(key: string): Promise<void> {
    memDelete(key);
    await XtreamCache.destroy({ where: { key } });
  },
};

// ── Category versioning ────────────────────────────────────────────────────────
// Each warm cycle that finds new content writes a fresh Unix timestamp as the
// version. The timestamp is appended to every VOD/series category ID in Xtream
// API responses. The player sees new category IDs and re-fetches stream lists.
// Internally all cache lookups always use the bare (unversioned) genre ID, so
// a single vod_cat_version row in SystemConfig is the only moving part.

export async function getVodVersion(): Promise<number> {
  try {
    const row = await SystemConfig.findByPk("vod_cat_version");
    return row ? (Number(row.value) || 1) : 1;
  } catch { return 1; }
}

let bumpInProgress = false;
export async function bumpVodVersion(): Promise<void> {
  if (bumpInProgress) return;
  bumpInProgress = true;
  try {
    const ts = Date.now();
    await SystemConfig.upsert({ key: "vod_cat_version", value: ts });
    logger.info(`[Xtream] VOD category version set to ${ts}`);
  } finally {
    bumpInProgress = false;
  }
}

// `portal_series_source` almost never changes at runtime (it's set once when the provider's
// series mode is detected) but was being re-fetched from SQLite + JSON.parse'd on every single
// VOD/series request. Memoize it for a short window so bursts of requests share one DB read,
// while still picking up a change (e.g. provider switch) within a few seconds.
const SERIES_SOURCE_TTL_MS = 5000;
let seriesSourceCache: { value: boolean; expiresAt: number } | undefined;

async function isNativeSeriesSource(): Promise<boolean> {
  if (seriesSourceCache && seriesSourceCache.expiresAt > Date.now()) {
    return seriesSourceCache.value;
  }
  const sourceRow = await XtreamCache.findOne({ where: { key: "portal_series_source" } });
  const value = sourceRow ? JSON.parse(sourceRow.value) === "native" : false;
  seriesSourceCache = { value, expiresAt: Date.now() + SERIES_SOURCE_TTL_MS };
  return value;
}

export const vodVersioningEnabled = process.env.VOD_CATEGORY_VERSIONING === "true";

export function addVer(id: string | number, v: number): string {
  return vodVersioningEnabled ? `${id}_v${v}` : String(id);
}

export function stripVer(id: string): string {
  return id.replace(/_v\d+$/, "");
}

// Stores the REAL upstream URL — this is our own persisted cache, never sent
// to a client directly. Every place that serves this back out in an Xtream
// API response converts it to a same-origin proxied URL per-request via
// absolutizeIconFields (infra/publicUrl.ts), the same way mapChannel/
// enrichArtworkFromTmdb/Discover all convert at serve time rather than at
// write time — so there's nothing to backfill/migrate if this logic ever
// changes again, and no legacy-shaped rows to worry about.
export function buildIconUrl(uri: string | undefined): string {
  if (!uri) return "";
  if (uri.startsWith("http")) return uri;
  const proto = initialConfig.https ? "https" : "http";
  return `${proto}://${initialConfig.hostname}:${initialConfig.port}${uri}`;
}

export async function fetchAllPages(
  fetcher: (page: number) => Promise<any[]>,
  startPage = 1,
): Promise<any[]> {
  const all: any[] = [];
  let page = startPage;
  while (true) {
    const items = await fetcher(page);
    if (items.length === 0) break;
    all.push(...items);
    page++;
  }
  return all;
}

// Fetch pages until a known item is encountered; returns only the new items.
async function fetchUntilKnown(
  fetcher: (page: number) => Promise<any[]>,
  isKnown: (item: any) => boolean,
): Promise<any[]> {
  const newItems: any[] = [];
  let page = 1;
  while (true) {
    const items = await fetcher(page);
    if (items.length === 0) break;
    newItems.push(...items.filter((item) => !isKnown(item)));
    if (items.some((item) => isKnown(item))) break;
    page++;
  }
  return newItems;
}

let seriesWarmRunning = false;
let vodWarmRunning    = false;

function toUnixAdded(added: any): string {
  if (!added) return "";
  const n = Number(added);
  if (!isNaN(n) && n > 1000000000) return String(n);
  const d = new Date(added);
  return isNaN(d.getTime()) ? "" : String(Math.floor(d.getTime() / 1000));
}

export function mapVodItem(m: any, num: number, categoryId: string | number): any {
  const added = toUnixAdded(m.added);
  if (m.cmd) xtreamCache.set(`vod_cmd_${m.id}`, m.cmd).catch(() => {});
  xtreamCache.set(`vod_info_${m.id}`, {
    info: {
      name:          m.name,
      cover_big:     buildIconUrl(m.screenshot_uri),
      movie_image:   buildIconUrl(m.screenshot_uri),
      releasedate:   m.year || "",
      director:      m.director || "",
      actors:        m.actors || "",
      plot:          m.description || "",
      rating:        m.rating_imdb || 0,
      backdrop_path: [],
      duration_secs: parseInt(m.time) || 0,
      genre:         m.genres_str || "",
      age:           m.rating_mpaa || m.age || "",
    },
    movie_data: {
      stream_id:           parseInt(m.id),
      name:                m.name,
      added,
      category_id:         String(categoryId),
      container_extension: "m3u8",
      custom_sid:          "",
      direct_source:       "",
    },
  }).catch(() => {});
  return {
    num,
    name:                m.name,
    stream_type:         "movie",
    stream_id:           parseInt(m.id),
    stream_icon:         buildIconUrl(m.screenshot_uri),
    rating:              m.rating_imdb || 0,
    year:                m.year || "",
    added,
    category_id:         String(categoryId),
    container_extension: "m3u8",
    custom_sid:          "",
    direct_source:       "",
    // Portal-native fields the Xtream protocol doesn't use, but the web UI does — this
    // cache entry is shared by both consumers, so keep them alongside the Xtream shape.
    screenshot_uri:      m.screenshot_uri || "",
    description:         m.description || "",
    actors:              m.actors || "",
    director:            m.director || "",
    genres_str:          m.genres_str || "",
    rating_imdb:         m.rating_imdb,
    rating_mpaa:         m.rating_mpaa || "",
    age:                 m.age || "",
    country:             m.country || "",
    duration:            m.duration,
  };
}

function mapSeriesItem(s: any, num: number, categoryId: string | number): any {
  return {
    num,
    name:             s.name,
    series_id:        parseInt(s.id),
    cover:            buildIconUrl(s.screenshot_uri),
    plot:             s.description || "",
    cast:             s.actors || "",
    director:         s.director || "",
    genre:            s.genres_str || "",
    releaseDate:      s.year || "",
    last_modified:    s.added || "",
    rating:           s.rating_imdb || 0,
    category_id:      String(categoryId),
    youtube_trailer:  "",
    episode_run_time: "",
    backdrop_path:    [],
    // Portal-native fields the Xtream protocol doesn't use, but the web UI does — this
    // cache entry is shared by both consumers, so keep them alongside the Xtream shape.
    screenshot_uri:   s.screenshot_uri || "",
    description:      s.description || "",
    actors:           s.actors || "",
    genres_str:       s.genres_str || "",
    rating_imdb:      s.rating_imdb,
    rating_mpaa:      s.rating_mpaa || "",
    age:              s.age || "",
    country:          s.country || "",
  };
}

// Concurrent calls for the same category (e.g. a double-fired category click,
// or the web UI and a warm cycle overlapping) previously each independently
// read the same stale cache snapshot, fetched, merged, and wrote back — a
// classic read-modify-write race where whichever write lands last silently
// wins, discarding or duplicating whatever the other one computed. Dedupe by
// categoryId so only one refresh per category is ever in flight at a time.
const vodRefreshInFlight = new Map<string, Promise<any[]>>();
const seriesRefreshInFlight = new Map<string, Promise<any[]>>();

// Shared by both the Xtream player API (get_vod_streams) and the web UI (/api/v2/movies)
// so both surfaces see identical staleness/refresh behavior instead of diverging.
export async function getOrRefreshVodStreams(categoryId: string): Promise<any[]> {
  const pending = vodRefreshInFlight.get(categoryId);
  if (pending) return pending;
  const promise = getOrRefreshVodStreamsInner(categoryId).finally(() => {
    vodRefreshInFlight.delete(categoryId);
  });
  vodRefreshInFlight.set(categoryId, promise);
  return promise;
}

// Stale-cache refresh used to run synchronously in the request path, blocking the
// response on an upstream provider round-trip once per category per TTL window (24h).
// The warm/catchup background jobs already keep content fresh on their own schedule,
// so a stale read here is rare and the freshest-possible response isn't worth making
// every unlucky first-request-of-the-day wait on the provider. Serve the stale cache
// immediately and refresh it in the background instead; the next request picks up the
// updated result. Deduped separately from vodRefreshInFlight (which only covers the
// cache-miss path) so concurrent stale reads don't each kick off their own refresh.
const vodBackgroundRefreshing = new Set<string>();
const seriesBackgroundRefreshing = new Set<string>();

function refreshVodStreamsInBackground(categoryId: string, cached: any[]): void {
  if (vodBackgroundRefreshing.has(categoryId)) return;
  vodBackgroundRefreshing.add(categoryId);
  const cacheKey = `vod_streams_${categoryId}`;
  (async () => {
    const provider = serverManager.getProvider();
    const existingMovieIds = new Set(cached.map((m: any) => String(m.stream_id)));
    const existingSeries = await xtreamCache.get<any[]>(`series_list_${categoryId}`);
    const existingSeriesIds = new Set((existingSeries || []).map((s: any) => String(s.series_id)));
    const newRaw = await fetchUntilKnown(
      async (page) => {
        const res = await provider.getMovies({ category: categoryId, page });
        return res?.js?.data || [];
      },
      (item) => existingMovieIds.has(String(item.id)) || existingSeriesIds.has(String(item.id)),
    );
    const newItems = newRaw.filter((i: any) => i[seriesFlag] != 1);
    if (newItems.length === 0) {
      await xtreamCache.set(cacheKey, cached);
      return;
    }
    const result = [
      ...newItems.map((m, idx) => mapVodItem(m, idx + 1, categoryId)),
      ...cached.map((m: any, idx: number) => ({ ...m, num: newItems.length + idx + 1 })),
    ];
    await xtreamCache.set(cacheKey, result);
  })()
    .catch((e: any) => logger.error(`[XtreamCache] Background refresh failed for ${cacheKey}: ${e.message}`))
    .finally(() => vodBackgroundRefreshing.delete(categoryId));
}

async function getOrRefreshVodStreamsInner(categoryId: string): Promise<any[]> {
  const provider = serverManager.getProvider();
  const cacheKey = `vod_streams_${categoryId}`;
  const { value: cached, isStale } = await xtreamCache.getWithStaleness<any[]>(cacheKey);

  if (cached && !isStale) return cached;

  if (cached) {
    refreshVodStreamsInBackground(categoryId, cached);
    return cached;
  }

  // Cache miss — full fetch
  const allRawVod = await fetchAllPages(async (page) => {
    const res = await provider.getMovies({ category: categoryId, page });
    return res?.js?.data || [];
  });
  if (allRawVod.length === 0) return [];
  const vodItems = allRawVod.filter((i: any) => i[seriesFlag] != 1);
  const result = vodItems.map((m, idx) => mapVodItem(m, idx + 1, categoryId));
  await xtreamCache.set(cacheKey, result);
  return result;
}

export async function getOrRefreshSeriesList(categoryId: string): Promise<any[]> {
  const pending = seriesRefreshInFlight.get(categoryId);
  if (pending) return pending;
  const promise = getOrRefreshSeriesListInner(categoryId).finally(() => {
    seriesRefreshInFlight.delete(categoryId);
  });
  seriesRefreshInFlight.set(categoryId, promise);
  return promise;
}

function refreshSeriesListInBackground(categoryId: string, cached: any[], isNativeSeries: boolean): void {
  if (seriesBackgroundRefreshing.has(categoryId)) return;
  seriesBackgroundRefreshing.add(categoryId);
  const cacheKey = `series_list_${categoryId}`;
  (async () => {
    const provider = serverManager.getProvider();
    const existingSeriesIds = new Set(cached.map((s: any) => String(s.series_id)));
    const existingMovies = isNativeSeries ? null : await xtreamCache.get<any[]>(`vod_streams_${categoryId}`);
    const existingMovieIds = new Set((existingMovies || []).map((m: any) => String(m.stream_id)));
    const newRaw = await fetchUntilKnown(
      async (page) => {
        const res = isNativeSeries
          ? await provider.getSeries({ category: categoryId, page })
          : await provider.getMovies({ category: categoryId, page });
        return res?.js?.data || [];
      },
      (item) => existingSeriesIds.has(String(item.id)) || existingMovieIds.has(String(item.id)),
    );
    const newItems = isNativeSeries ? newRaw : newRaw.filter((i: any) => i[seriesFlag] == 1);
    if (newItems.length === 0) {
      await xtreamCache.set(cacheKey, cached);
      return;
    }
    const result = [
      ...newItems.map((s, idx) => mapSeriesItem(s, idx + 1, categoryId)),
      ...cached.map((s: any, idx: number) => ({ ...s, num: newItems.length + idx + 1 })),
    ];
    await xtreamCache.set(cacheKey, result);
  })()
    .catch((e: any) => logger.error(`[XtreamCache] Background refresh failed for ${cacheKey}: ${e.message}`))
    .finally(() => seriesBackgroundRefreshing.delete(categoryId));
}

async function getOrRefreshSeriesListInner(categoryId: string): Promise<any[]> {
  const provider = serverManager.getProvider();
  const cacheKey = `series_list_${categoryId}`;
  const { value: cached, isStale } = await xtreamCache.getWithStaleness<any[]>(cacheKey);
  const isNativeSeries = await isNativeSeriesSource();

  if (cached && !isStale) return cached;

  if (cached) {
    refreshSeriesListInBackground(categoryId, cached, isNativeSeries);
    return cached;
  }

  // Cache miss — full fetch
  let allRaw: any[];
  let seriesItems: any[];
  if (isNativeSeries) {
    allRaw = await fetchAllPages(async (page) => {
      const res = await provider.getSeries({ category: categoryId, page });
      return res?.js?.data || [];
    });
    seriesItems = allRaw;
  } else {
    allRaw = await fetchAllPages(async (page) => {
      const res = await provider.getMovies({ category: categoryId, page });
      return res?.js?.data || [];
    });
    seriesItems = allRaw.filter((i: any) => i[seriesFlag] == 1);
  }
  if (allRaw.length === 0) return [];
  const result = seriesItems.map((s, idx) => mapSeriesItem(s, idx + 1, categoryId));
  await xtreamCache.set(cacheKey, result);
  return result;
}

export async function warmSeriesCache(): Promise<boolean> {
  if (seriesWarmRunning) { logger.info("[XtreamSeries] Warm already running, skipping"); return false; }
  seriesWarmRunning = true;
  let newContentFound = false;
  try {
    const isNativeSeries = await isNativeSeriesSource();
    const genres = await readGenres("series");
    const provider = serverManager.getProvider();

    for (const genre of genres) {
      if (!genre.id || genre.id === "*") continue;
      const cacheKey = `series_list_${genre.id}`;
      try {
        const existing = await xtreamCache.get<any[]>(cacheKey) || [];
        const existingSeriesIds = new Set(existing.map((s: any) => String(s.series_id)));
        const cachedMovies = (await xtreamCache.get<any[]>(`vod_streams_${genre.id}`)) || [];
        const existingMovieIds = new Set(cachedMovies.map((m: any) => String(m.stream_id)));
        const isKnown = (item: any) =>
          existingSeriesIds.has(String(item.id)) || existingMovieIds.has(String(item.id));

        const newRaw = await fetchUntilKnown(
          async (page) => {
            const res = isNativeSeries
              ? await provider.getSeries({ category: genre.id, page })
              : await provider.getMovies({ category: genre.id, page });
            return res?.js?.data || [];
          },
          isKnown,
        );
        const newSeries = isNativeSeries ? newRaw : newRaw.filter((i: any) => i[seriesFlag] == 1);
        const newMovies = isNativeSeries ? [] : newRaw.filter((i: any) => i[seriesFlag] != 1);

        if (newSeries.length === 0 && newMovies.length === 0) {
          if (!isNativeSeries && cachedMovies.length > 0) {
            await upsertGenre(genre, "movie"); // keep genre registered
          }
          if (existing.length > 0) await xtreamCache.set(cacheKey, existing);
          logger.info(`[XtreamSeries] ${cacheKey}: up to date, skipping`);
          continue;
        }

        if (newSeries.length > 0) {
          newContentFound = true;
          const result = [
            ...newSeries.map((s, idx) => mapSeriesItem(s, idx + 1, genre.id)),
            ...existing.map((s: any, idx: number) => ({ ...s, num: newSeries.length + idx + 1 })),
          ];
          await xtreamCache.set(cacheKey, result);
          logger.info(`[XtreamSeries] ${cacheKey}: ${existing.length === 0 ? "warmed" : "added"} ${newSeries.length} series (total=${result.length})`);
        }

        if (newMovies.length > 0) {
          newContentFound = true;
          const vodKey = `vod_streams_${genre.id}`;
          const result = [
            ...newMovies.map((m, idx) => mapVodItem(m, idx + 1, genre.id)),
            ...cachedMovies.map((m: any, idx: number) => ({ ...m, num: newMovies.length + idx + 1 })),
          ];
          await xtreamCache.set(vodKey, result);
          logger.info(`[XtreamSeries] ${vodKey}: ${cachedMovies.length === 0 ? "warmed" : "added"} ${newMovies.length} movies (total=${result.length})`);
          // Category has movies — register it in movie genres so it's visible in the VOD section
          if (!isNativeSeries) await upsertGenre(genre, "movie");

        }

      } catch (e: any) {
        logger.error(`[XtreamSeries] Failed to warm ${cacheKey}: ${e.message}`);
      }
    }

  } finally {
    if (newContentFound) {
      try { await bumpVodVersion(); } catch (e: any) { logger.error(`[XtreamSeries] Failed to bump version: ${e.message}`); }
    }
    seriesWarmRunning = false;
  }
  return newContentFound;
}

export async function warmSeriesInfoCache(): Promise<void> {
  const genres = await readGenres("series");
  const provider = serverManager.getProvider();
  const seen = new Set<number>();

  for (const genre of genres) {
    if (!genre.id || genre.id === "*") continue;
    const seriesList = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
    if (!seriesList) continue;

    for (const series of seriesList) {
      const seriesId = series.series_id as number;
      if (!seriesId || seen.has(seriesId)) continue;
      seen.add(seriesId);

      const cacheKey = `series_info_${seriesId}`;
      const existing = await XtreamCache.findOne({ where: { key: cacheKey } });
      if (existing) {
        try {
          const data = JSON.parse(existing.value);
          const hasEpisodes = Object.values(data?.episodes || {}).some((eps: any) => eps?.length > 0);
          const hasContent = (data?.seasons?.length > 0) && hasEpisodes;
          if (hasContent) continue;
        } catch { continue; }
      }

      try {
        // Throttle to avoid 429 from portal
        await new Promise((r) => setTimeout(r, 500));

        const seasonsData = await provider.getMovies({ category: "*", page: 1, movieId: seriesId });
        const allItems = (seasonsData?.js?.data || []) as any[];
        let seasons = allItems.filter((s: any) => s.is_season);
        // Fallback: portal may not set is_season — detect by season_number/season_name
        if (seasons.length === 0) {
          const candidates = allItems.filter((s: any) => !s.is_episode && s.id);
          seasons = candidates.filter((s: any) => s.season_number || s.season_name);
        }
        const seriesItem = allItems.find((i: any) => i[seriesFlag]) || allItems[0];

        logger.info(`[XtreamSeriesInfo] ${cacheKey}: ${allItems.length} items, ${seasons.length} seasons (first keys: ${allItems[0] ? Object.keys(allItems[0]).slice(0, 8).join(",") : "none"})`);

        const episodesMap: Record<string, any[]> = {};
        let totalEpInfo = 0;

        for (const season of seasons) {
          await new Promise((r) => setTimeout(r, 300));
          const seasonNum = String(season.season_number || "1");
          const seasonIdInt = parseInt(season.id);
          let allEps = await fetchAllPages(async (page) => {
            const r = await provider.getMovies({ category: "*", page, movieId: seriesId, seasonId: seasonIdInt });
            return r?.js?.data || [];
          });
          // Fallback: some portals store episodes under type:"series" not type:"vod"
          if (allEps.length === 0) {
            allEps = await fetchAllPages(async (page) => {
              const r = await provider.getSeries({ category: "*", page, movieId: seriesId, seasonId: seasonIdInt });
              return r?.js?.data || [];
            });
          }
          const episodes = allEps.filter((e: any) => e.is_episode);
          // Fallback: portal may not set is_episode flag — use all returned items
          const effectiveEps = episodes.length > 0 ? episodes : allEps;
          logger.info(`[XtreamSeriesInfo] ${cacheKey} season ${seasonNum} (id=${season.id}): ${allEps.length} raw items, ${effectiveEps.length} effective eps`);

          episodesMap[seasonNum] = effectiveEps.map((ep: any, idx: number) => {
            const epNum = parseInt(String(ep.series_number || (idx + 1)));
            xtreamCache.set(`ep_info_${ep.id}`, {
              movieId:   seriesId,
              seasonId:  seasonIdInt,
              seriesNum: epNum,
            }).catch(() => {});
            totalEpInfo++;
            if (ep.cmd) {
              xtreamCache.set(`ep_cmd_${ep.id}`, { cmd: ep.cmd, series_num: epNum }).catch(() => {});
            }
            return {
              id:                  ep.id,
              episode_num:         epNum,
              title:               ep.name || `Episode ${epNum}`,
              container_extension: "m3u8",
              info: {
                season:        parseInt(seasonNum),
                plot:          "",
                duration_secs: 0,
                rating:        0,
                movie_image:   "",
                releasedate:   ep.date_add || "",
              },
              direct_source: "",
            };
          });
        }

        const result = {
          info: {
            name:             seriesItem?.name || "",
            cover:            buildIconUrl(seriesItem?.screenshot_uri),
            plot:             seriesItem?.description || "",
            cast:             seriesItem?.actors || "",
            director:         seriesItem?.director || "",
            genre:            seriesItem?.genres_str || "",
            releaseDate:      seriesItem?.year || "",
            rating:           seriesItem?.rating_imdb || 0,
            backdrop_path:    [],
            youtube_trailer:  "",
            episode_run_time: "",
            category_id:      seriesItem?.category_id || "0",
          },
          episodes: episodesMap,
          seasons: seasons.map((s: any) => ({
            air_date:      s.date_add || "",
            episode_count: parseInt(s.season_series || 0),
            id:            parseInt(s.id),
            name:          s.season_name || `Season ${s.season_number}`,
            overview:      "",
            season_number: parseInt(s.season_number || 1),
            cover:         "",
            cover_big:     "",
          })),
        };

        await xtreamCache.set(cacheKey, result);
        logger.info(`[XtreamSeriesInfo] Warmed ${cacheKey}: ${totalEpInfo} episodes indexed`);
      } catch (e: any) {
        logger.error(`[XtreamSeriesInfo] Failed ${cacheKey}: ${e.message}`);
      }
    }
  }
}

let catchupRunning = false;

export interface CatchupScanOptions {
  // Scopes the scan to just these genre ids instead of the whole catalog —
  // used by the daily rotating stale-content sweep (metaEnrichment.ts) so it
  // only pays for a handful of categories per run, not a full-catalog pass.
  // Omit (the manual /api/v2/catchup-scan endpoint's usage) to scan everything.
  genreIds?: string[];
  // Called for every id this scan confirms is no longer on the portal, before
  // it's dropped from the XtreamCache list. catchupScan itself only
  // reconciles that list cache — it has no notion of ContentMeta/Discover
  // tags/UserProgress, so without this callback a "removed" id here would
  // still leave orphaned metadata/Continue-Watching rows behind. Awaited
  // sequentially per removal, same throttle-friendly shape as the rest of
  // this file.
  onRemoved?: (contentId: string, categoryId: string) => Promise<void> | void;
  // Optional pause between each genre's reconcile call — the manual full-scan
  // endpoint has run throttle-free since it existed, so this defaults to 0
  // there; the daily rotating sweep passes a real value since even 5
  // categories a day is worth pacing.
  throttleMs?: number;
}

// Returns whether the scan actually ran (false = skipped because another
// scan was already in progress) — callers that track external state keyed
// to "this scan happened" (e.g. the rotating sweep's cursor) need to know
// the difference between "ran and found nothing to change" and "didn't run
// at all," since silently treating a skip as a completed pass would advance
// past categories that were never actually checked.
export async function catchupScan(options: CatchupScanOptions = {}): Promise<boolean> {
  const { genreIds, onRemoved, throttleMs = 0 } = options;
  const genreFilter = genreIds ? new Set(genreIds.map(String)) : null;
  if (catchupRunning) { logger.info("[Catchup] Already running, skipping"); return false; }
  catchupRunning = true;
  try {
    const provider = serverManager.getProvider();
    const isNativeSeries = await isNativeSeriesSource();

    // ── Helper: reconcile a mixed movie+series category from getMovies() ────────
    const reconcileMovieGenre = async (genre: any) => {
      const vodKey    = `vod_streams_${genre.id}`;
      const seriesKey = `series_list_${genre.id}`;

      const page1Res    = await provider.getMovies({ category: genre.id, page: 1 });
      const portalTotal = Number(page1Res?.js?.total_items ?? 0);
      const page1Items: any[] = page1Res?.js?.data || [];
      if (portalTotal === 0 || page1Items.length === 0) return;

      const existingMovies  = await xtreamCache.get<any[]>(vodKey)    || [];
      const existingSeries  = isNativeSeries ? [] : (await xtreamCache.get<any[]>(seriesKey) || []);
      const localTotal      = existingMovies.length + existingSeries.length;
      const diff            = portalTotal - localTotal;

      if (diff === 0) {
        logger.info(`[Catchup] ${vodKey}: in sync (total=${portalTotal}), skipping`);
        return;
      }

      const existingMovieIds  = new Set(existingMovies.map((m: any) => String(m.stream_id)));
      const existingSeriesIds = new Set(existingSeries.map((s: any) => String(s.series_id)));

      if (diff > 0) {
        // ── Incremental add: scan from front, stop once balance reaches diff ────
        // "balance" = items added so far - items confirmed deleted so far
        // This handles mixed cases: e.g. portal removed 8 and added 13 (net +5).
        logger.info(`[Catchup] ${vodKey}: net +${diff} — incremental scan (local=${localTotal}, portal=${portalTotal})`);

        const toAddMovies: any[]  = [];
        const toAddSeries: any[]  = [];
        const seenPortalIds       = new Set<string>();
        let balance = 0;
        let done    = false;

        for (let page = 1; !done; page++) {
          const items: any[] = page === 1 ? page1Items : ((await provider.getMovies({ category: genre.id, page }))?.js?.data || []);
          if (items.length === 0) break;

          for (const item of items) {
            const id       = String(item.id);
            const isSeries = item[seriesFlag] == 1;
            seenPortalIds.add(`${isSeries ? "s" : "m"}:${id}`);

            const isNew = isSeries ? !existingSeriesIds.has(id) : !existingMovieIds.has(id);
            if (isNew) {
              if (isSeries) toAddSeries.push(item); else toAddMovies.push(item);
              balance++;
              if (balance >= diff) { done = true; break; }
            }
          }
        }

        // Any local items NOT seen in the pages we scanned were deleted from portal
        const deletedMovieIds  = new Set([...existingMovieIds].filter(id => seenPortalIds.has(`m:${id}`) === false && balance < diff));
        const deletedSeriesIds = new Set([...existingSeriesIds].filter(id => seenPortalIds.has(`s:${id}`) === false && balance < diff));

        if (onRemoved) {
          for (const id of deletedMovieIds) await onRemoved(`movie_${id}`, genre.id);
          for (const id of deletedSeriesIds) await onRemoved(`series_${id}`, genre.id);
        }

        const keptMovies  = existingMovies.filter((m: any) => !deletedMovieIds.has(String(m.stream_id)));
        const keptSeries  = existingSeries.filter((s: any) => !deletedSeriesIds.has(String(s.series_id)));

        if (toAddMovies.length > 0 || deletedMovieIds.size > 0) {
          const all = [
            ...toAddMovies.map((m, i) => mapVodItem(m, i + 1, genre.id)),
            ...keptMovies.map((m: any, i: number) => ({ ...m, num: toAddMovies.length + i + 1 })),
          ];
          await xtreamCache.set(vodKey, all);
          logger.info(`[Catchup] ${vodKey}: +${toAddMovies.length} added, -${deletedMovieIds.size} removed (total=${all.length})`);
        }
        if (!isNativeSeries && (toAddSeries.length > 0 || deletedSeriesIds.size > 0)) {
          const all = [
            ...toAddSeries.map((s, i) => mapSeriesItem(s, i + 1, genre.id)),
            ...keptSeries.map((s: any, i: number) => ({ ...s, num: toAddSeries.length + i + 1 })),
          ];
          await xtreamCache.set(seriesKey, all);
          logger.info(`[Catchup] ${seriesKey}: +${toAddSeries.length} added, -${deletedSeriesIds.size} removed (total=${all.length})`);
        }

      } else {
        // ── Deletions detected: scan ALL pages to find what's gone, pick up new items too ──
        logger.info(`[Catchup] ${vodKey}: net ${diff} — scanning all pages to find deletions (local=${localTotal}, portal=${portalTotal})`);

        const portalMovieIds  = new Set<string>();
        const portalSeriesIds = new Set<string>();
        const toAddMovies: any[] = [];
        const toAddSeries: any[] = [];

        const allPortalItems = [
          ...page1Items,
          ...await fetchAllPages(async (page) => {
            const res = await provider.getMovies({ category: genre.id, page });
            return res?.js?.data || [];
          }, 2),
        ];

        for (const item of allPortalItems) {
          const id       = String(item.id);
          const isSeries = item[seriesFlag] == 1;
          if (isSeries) {
            portalSeriesIds.add(id);
            if (!existingSeriesIds.has(id)) toAddSeries.push(item);
          } else {
            portalMovieIds.add(id);
            if (!existingMovieIds.has(id)) toAddMovies.push(item);
          }
        }

        const keptMovies  = existingMovies.filter((m: any) => portalMovieIds.has(String(m.stream_id)));
        const removedMovieIds = existingMovies.filter((m: any) => !portalMovieIds.has(String(m.stream_id))).map((m: any) => String(m.stream_id));
        if (onRemoved) for (const id of removedMovieIds) await onRemoved(`movie_${id}`, genre.id);
        const allMovies = [
          ...toAddMovies.map((m, i) => mapVodItem(m, i + 1, genre.id)),
          ...keptMovies.map((m: any, i: number) => ({ ...m, num: toAddMovies.length + i + 1 })),
        ];
        await xtreamCache.set(vodKey, allMovies);
        logger.info(`[Catchup] ${vodKey}: -${removedMovieIds.length} removed, +${toAddMovies.length} added (total=${allMovies.length})`);

        if (!isNativeSeries) {
          const keptSeries  = existingSeries.filter((s: any) => portalSeriesIds.has(String(s.series_id)));
          const removedSeriesIds = existingSeries.filter((s: any) => !portalSeriesIds.has(String(s.series_id))).map((s: any) => String(s.series_id));
          if (onRemoved) for (const id of removedSeriesIds) await onRemoved(`series_${id}`, genre.id);
          const allSeries = [
            ...toAddSeries.map((s, i) => mapSeriesItem(s, i + 1, genre.id)),
            ...keptSeries.map((s: any, i: number) => ({ ...s, num: toAddSeries.length + i + 1 })),
          ];
          await xtreamCache.set(seriesKey, allSeries);
          logger.info(`[Catchup] ${seriesKey}: -${removedSeriesIds.length} removed, +${toAddSeries.length} added (total=${allSeries.length})`);
        }
      }
    };

    // ── Helper: reconcile a native series category from getSeries() ─────────────
    const reconcileSeriesGenre = async (genre: any) => {
      const seriesKey = `series_list_${genre.id}`;

      const page1Res    = await provider.getSeries({ category: genre.id, page: 1 });
      const portalTotal = Number(page1Res?.js?.total_items ?? 0);
      const page1Items: any[] = page1Res?.js?.data || [];
      if (portalTotal === 0 || page1Items.length === 0) return;

      const existing   = await xtreamCache.get<any[]>(seriesKey) || [];
      const localTotal = existing.length;
      const diff       = portalTotal - localTotal;

      if (diff === 0) {
        logger.info(`[Catchup] ${seriesKey}: in sync (total=${portalTotal}), skipping`);
        return;
      }

      const existingIds = new Set(existing.map((s: any) => String(s.series_id)));

      if (diff > 0) {
        logger.info(`[Catchup] ${seriesKey}: net +${diff} — incremental scan (local=${localTotal}, portal=${portalTotal})`);

        const toAdd: any[]  = [];
        const seenIds       = new Set<string>();
        let balance = 0;
        let done    = false;

        for (let page = 1; !done; page++) {
          const items: any[] = page === 1 ? page1Items : ((await provider.getSeries({ category: genre.id, page }))?.js?.data || []);
          if (items.length === 0) break;
          for (const item of items) {
            const id = String(item.id);
            seenIds.add(id);
            if (!existingIds.has(id)) {
              toAdd.push(item);
              balance++;
              if (balance >= diff) { done = true; break; }
            }
          }
        }

        const deletedIds = new Set([...existingIds].filter(id => !seenIds.has(id) && balance < diff));
        if (onRemoved) for (const id of deletedIds) await onRemoved(`series_${id}`, genre.id);
        const kept       = existing.filter((s: any) => !deletedIds.has(String(s.series_id)));
        const all        = [
          ...toAdd.map((s, i) => mapSeriesItem(s, i + 1, genre.id)),
          ...kept.map((s: any, i: number) => ({ ...s, num: toAdd.length + i + 1 })),
        ];
        await xtreamCache.set(seriesKey, all);
        logger.info(`[Catchup] ${seriesKey}: +${toAdd.length} added, -${deletedIds.size} removed (total=${all.length})`);

      } else {
        logger.info(`[Catchup] ${seriesKey}: net ${diff} — scanning all pages to find deletions (local=${localTotal}, portal=${portalTotal})`);

        const allPortalItems = [
          ...page1Items,
          ...await fetchAllPages(async (page) => {
            const res = await provider.getSeries({ category: genre.id, page });
            return res?.js?.data || [];
          }, 2),
        ];

        const portalIds = new Set(allPortalItems.map((s: any) => String(s.id)));
        const toAdd     = allPortalItems.filter((s: any) => !existingIds.has(String(s.id)));
        const kept      = existing.filter((s: any) => portalIds.has(String(s.series_id)));
        const removedIds = existing.filter((s: any) => !portalIds.has(String(s.series_id))).map((s: any) => String(s.series_id));
        if (onRemoved) for (const id of removedIds) await onRemoved(`series_${id}`, genre.id);
        const all       = [
          ...toAdd.map((s, i) => mapSeriesItem(s, i + 1, genre.id)),
          ...kept.map((s: any, i: number) => ({ ...s, num: toAdd.length + i + 1 })),
        ];
        await xtreamCache.set(seriesKey, all);
        logger.info(`[Catchup] ${seriesKey}: -${removedIds.length} removed, +${toAdd.length} added (total=${all.length})`);
      }
    };

    const matchesFilter = (id: string) => !genreFilter || genreFilter.has(id);
    const pace = async () => { if (throttleMs > 0) await new Promise((r) => setTimeout(r, throttleMs)); };

    const movieGenres = await readGenres("movie");
    for (const genre of movieGenres) {
      if (!genre.id || genre.id === "*" || !matchesFilter(String(genre.id))) continue;
      try { await reconcileMovieGenre(genre); } catch (e: any) { logger.error(`[Catchup] Failed ${genre.id}: ${e.message}`); }
      await pace();
    }

    // Portal A: series-only genres not covered by movie genres loop
    if (!isNativeSeries) {
      const processedIds = new Set(movieGenres.map((g: any) => String(g.id)));
      const seriesGenres = await readGenres("series");
      for (const genre of seriesGenres) {
        if (!genre.id || genre.id === "*" || processedIds.has(String(genre.id)) || !matchesFilter(String(genre.id))) continue;
        try { await reconcileMovieGenre(genre); } catch (e: any) { logger.error(`[Catchup] Failed series-only genre ${genre.id}: ${e.message}`); }
        await pace();
      }
    }

    // Portal B: native series categories via getSeries()
    if (isNativeSeries) {
      const seriesGenres = await readGenres("series");
      for (const genre of seriesGenres) {
        if (!genre.id || genre.id === "*" || !matchesFilter(String(genre.id))) continue;
        try { await reconcileSeriesGenre(genre); } catch (e: any) { logger.error(`[Catchup] Failed series ${genre.id}: ${e.message}`); }
        await pace();
      }
    }

    await bumpVodVersion();
    logger.info("[Catchup] Scan complete");
    return true;
  } finally {
    catchupRunning = false;
  }
}

export async function cleanupGenres(): Promise<void> {
  const movieGenres = await readGenres("movie");
  const seriesGenres = await readGenres("series");

  for (const genre of movieGenres) {
    if (!genre.id || genre.id === "*") continue;
    const vodCached = await xtreamCache.get<any[]>(`vod_streams_${genre.id}`);
    const seriesCached = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
    // Delete if vod cache is explicitly empty, or if vod is missing but series has data (confirmed series-only)
    const shouldDelete = (vodCached !== undefined && vodCached.length === 0) ||
                         (vodCached === undefined && seriesCached !== undefined && seriesCached.length > 0);
    if (shouldDelete) {
      await deleteGenre(genre, "movie");
      logger.info(`[Cleanup] Removed movie genre ${genre.id} (${genre.title}) from movie genres`);
    }
  }

  for (const genre of seriesGenres) {
    if (!genre.id || genre.id === "*") continue;
    const seriesCached = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
    const vodCached = await xtreamCache.get<any[]>(`vod_streams_${genre.id}`);
    // Delete if series cache is explicitly empty, or if series is missing but vod has data (confirmed movies-only)
    const noSeriesData = (seriesCached !== undefined && seriesCached.length === 0) ||
                         (seriesCached === undefined && vodCached !== undefined && vodCached.length > 0);
    if (noSeriesData) {
      await deleteGenre(genre, "series");
      logger.info(`[Cleanup] Removed series genre ${genre.id} (${genre.title}) from series genres — no series data`);
      continue;
    }
    // If series exist, check if any have episodes — skip if series_info not yet populated
    if (seriesCached && seriesCached.length > 0) {
      let hasAnyEpisodes = false;
      let allInfoAvailable = true;
      for (const series of seriesCached) {
        const info = await xtreamCache.get<any>(`series_info_${series.series_id}`);
        if (info === undefined) { allInfoAvailable = false; break; }
        const totalEps = Object.values(info.episodes || {}).reduce((sum: number, eps: any) => sum + (Array.isArray(eps) ? eps.length : 0), 0);
        if (totalEps > 0) { hasAnyEpisodes = true; break; }
      }
      if (allInfoAvailable && !hasAnyEpisodes) {
        await deleteGenre(genre, "series");
        logger.info(`[Cleanup] Removed series genre ${genre.id} (${genre.title}) from series genres — all series have 0 episodes`);
      }
    }
  }
}

export async function warmVodCache(): Promise<boolean> {
  if (vodWarmRunning) { logger.info("[XtreamVod] Warm already running, skipping"); return false; }
  vodWarmRunning = true;
  let newContentFound = false;
  try {
    const genres = await readGenres("movie");
    const provider = serverManager.getProvider();

    for (const genre of genres) {
      if (!genre.id || genre.id === "*") continue;
      const cacheKey = `vod_streams_${genre.id}`;
      try {
        const existing = await xtreamCache.get<any[]>(cacheKey) || [];
        const existingSeries = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
        const existingMovieIds  = new Set(existing.map((m: any) => String(m.stream_id)));
        const existingSeriesIds = new Set((existingSeries || []).map((s: any) => String(s.series_id)));
        const isKnown = (item: any) =>
          existingMovieIds.has(String(item.id)) || existingSeriesIds.has(String(item.id));

        const newRaw = await fetchUntilKnown(
          async (page) => {
            const res = await provider.getMovies({ category: genre.id, page });
            return res?.js?.data || [];
          },
          isKnown,
        );
        const newMovies = newRaw.filter((i: any) => i[seriesFlag] != 1);
        const newSeries = newRaw.filter((i: any) => i[seriesFlag] == 1);

        if (newMovies.length === 0 && newSeries.length === 0) {
          // vod_streams up to date — but check if series were ever discovered for this category
          if (existingSeries === undefined) {
            // First time: full scan to find any series buried in the category
            const seriesKey = `series_list_${genre.id}`;
            const allItems = await fetchAllPages(async (page) => {
              const res = await provider.getMovies({ category: genre.id, page });
              return res?.js?.data || [];
            });
            const seriesItems = allItems.filter((i: any) => i[seriesFlag] == 1);
            if (seriesItems.length > 0) {
              await xtreamCache.set(seriesKey, seriesItems.map((s: any, idx: number) => mapSeriesItem(s, idx + 1, genre.id)));
              await upsertGenre(genre, "series");
              logger.info(`[XtreamVOD] ${seriesKey}: discovered ${seriesItems.length} series (first scan)`);
            } else {
              await xtreamCache.set(seriesKey, []); // mark as scanned so we don't re-scan next time
            }
          } else if (existingSeries.length > 0) {
            await upsertGenre(genre, "series"); // keep genre registered
          }
          if (existing.length > 0) await xtreamCache.set(cacheKey, existing);
          logger.info(`[XtreamVOD] ${cacheKey}: up to date, skipping`);
          continue;
        }

        if (newMovies.length > 0) {
          newContentFound = true;
          const result = [
            ...newMovies.map((m, idx) => mapVodItem(m, idx + 1, genre.id)),
            ...existing.map((m: any, idx: number) => ({ ...m, num: newMovies.length + idx + 1 })),
          ];
          await xtreamCache.set(cacheKey, result);
          logger.info(`[XtreamVOD] ${cacheKey}: ${existing.length === 0 ? "warmed" : "added"} ${newMovies.length} movies (total=${result.length})`);
        }

        if (newSeries.length > 0) {
          newContentFound = true;
          const seriesKey = `series_list_${genre.id}`;
          const result = [
            ...newSeries.map((s, idx) => mapSeriesItem(s, idx + 1, genre.id)),
            ...(existingSeries || []).map((s: any, idx: number) => ({ ...s, num: newSeries.length + idx + 1 })),
          ];
          await xtreamCache.set(seriesKey, result);
          logger.info(`[XtreamVOD] ${seriesKey}: ${(existingSeries || []).length === 0 ? "warmed" : "added"} ${newSeries.length} series (total=${result.length})`);
          // Category has series — register it in series genres so it's visible in the series section
          await upsertGenre(genre, "series");

        }

      } catch (e: any) {
        logger.error(`[XtreamVOD] Failed to warm ${cacheKey}: ${e.message}`);
      }
    }

  } finally {
    if (newContentFound) {
      try { await bumpVodVersion(); } catch (e: any) { logger.error(`[XtreamVod] Failed to bump version: ${e.message}`); }
    }
    vodWarmRunning = false;
  }
  return newContentFound;
}
