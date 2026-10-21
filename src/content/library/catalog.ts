// Local titles served through the endpoints the apps already use (docs/skill-local-library.md):
//
//   GET /api/v2/movie-groups            -> "My Library" first, when a library has movies
//   GET /api/v2/movies?category=local   -> pages of local titles (ids "L<itemId>")
//   GET /api/v2/movies?movieId=L<id>    -> that title's files (ids "LF<fileId>"), best first
//   GET /api/v2/movie-link?id=LF<id>    -> /api/local/stream?t=<token>
//
// Items have the same shape as IPTV list items, so neither app needs to know where a title
// comes from. No path ever leaves the server: clients see ids and short-lived tokens.

import { needsBrowserFallback } from "@/content/library/remux";
import { artMarker } from "@/content/library/art";
import { Op } from "sequelize";
import { LocalItem } from "@/models/LocalItem";
import { MediaFile } from "@/models/MediaFile";
import { ContentMeta } from "@/models/ContentMeta";
import { ContentGenre } from "@/models/ContentGenre";
import { LOCAL_CATEGORY } from "@/content/metaEnrichment";
import { localContentId } from "@/content/library/scanner";
import { mintStreamToken } from "@/services/StreamTokens";
import { searchCatalog } from "@/content/searchIndex";

export const LOCAL_CATEGORY_TITLE = "My Library";

export function isLocalTitleId(id: unknown): boolean {
  return /^L\d+$/.test(String(id ?? ""));
}
export function isLocalFileId(id: unknown): boolean {
  return /^LF\d+$/.test(String(id ?? ""));
}

const RES_ORDER: Record<string, number> = { "2160p": 4, "1080p": 3, "720p": 2, SD: 1 };

/** The "My Library" category entry, or null when no library has a movie yet. */
export async function localMovieCategory(): Promise<any | null> {
  const n = await LocalItem.count({ where: { kind: "movie", missingSince: null } });
  if (n === 0) return null;
  return { id: LOCAL_CATEGORY, title: LOCAL_CATEGORY_TITLE, alias: LOCAL_CATEGORY, censored: 0, number: 0, type: "movie", isLocal: true };
}

const RES_LABEL_RE = /^(2160p|4k|uhd|1080p|1080i|720p|576p|480p|sd)$/i;

/** "4K · HDR10", "Director's Cut · 1080p": the probed size, else the size in the file name. */
function qualityLabel(f: MediaFile): string {
  const fromName = f.versionLabel && RES_LABEL_RE.test(f.versionLabel) ? f.versionLabel : null;
  const res = f.height
    ? (f.height >= 1800 ? "4K" : f.height >= 1000 ? "1080p" : f.height >= 700 ? "720p" : "SD")
    : fromName ? (/^(2160p|4k|uhd)$/i.test(fromName) ? "4K" : fromName) : null;
  const custom = f.versionLabel && !RES_LABEL_RE.test(f.versionLabel) ? f.versionLabel : null;
  return [custom, res, f.hdr].filter(Boolean).join(" · ");
}

/** A local title as an IPTV-shaped list item. */
function listItem(item: LocalItem, meta: ContentMeta | undefined, genres: string[], best: MediaFile | undefined): any {
  const id = `L${item.id}`;
  return {
    id,
    stream_id: id,
    num: item.id,
    name: meta?.trimmedName || meta?.name || item.name,
    title: meta?.trimmedName || meta?.name || item.name,
    stream_type: "movie",
    category_id: LOCAL_CATEGORY,
    year: meta?.year || item.year || undefined,
    added: Math.floor(new Date(item.createdAt).getTime() / 1000),
    screenshot_uri: meta?.poster || undefined,
    backdrop_path: meta?.backdrop || undefined,
    backdrop_hd_path: meta?.backdropHd || undefined,
    description: meta?.overview || undefined,
    actors: meta?.cast || undefined,
    director: meta?.director || undefined,
    genres_str: genres.join(", ") || undefined,
    duration: best?.duration ? Math.round(best.duration / 60) : undefined,
    container_extension: best?.container || undefined,
    is_series: 0,
    is_local: 1,
    quality: best ? qualityLabel(best) : undefined,
    tagline: meta?.tagline || undefined,
    rating_mpaa: meta?.ageRating || undefined,
    runtime: meta?.runtime || undefined,
    studios: meta?.studios || undefined,
    collection: meta?.collection || undefined,
    writers: meta?.writers || undefined,
    premiered: meta?.premiered || undefined,
    logo_path: meta?.logo || undefined,
  };
}

async function itemsWithMeta(items: LocalItem[]) {
  const contentIds = items.map((i) => localContentId(i.id));
  const metas = await ContentMeta.findAll({ where: { id: { [Op.in]: contentIds } } });
  const metaById = new Map(metas.map((m) => [m.id, m]));
  const genreRows = (await ContentGenre.findAll({ where: { contentId: { [Op.in]: contentIds } }, raw: true })) as any[];
  const genresById = new Map<string, string[]>();
  for (const g of genreRows) genresById.set(g.contentId, [...(genresById.get(g.contentId) ?? []), g.value]);
  const files = await MediaFile.findAll({ where: { itemId: { [Op.in]: items.map((i) => i.id) }, missingSince: null } });
  const bestByItem = new Map<number, MediaFile>();
  for (const f of files) {
    const cur = bestByItem.get(f.itemId);
    if (!cur || (f.height ?? 0) > (cur.height ?? 0)) bestByItem.set(f.itemId, f);
  }
  return items
    .filter((i) => bestByItem.has(i.id))
    .map((i) => listItem(i, metaById.get(localContentId(i.id)), genresById.get(localContentId(i.id)) ?? [], bestByItem.get(i.id)));
}

/** All present local movies, newest first (a page is a slice; search uses the same index as IPTV). */
export async function localMovieList(): Promise<any[]> {
  const items = await LocalItem.findAll({ where: { kind: "movie", missingSince: null }, order: [["createdAt", "DESC"]] });
  return itemsWithMeta(items);
}

export async function localMoviesPage(page: number, search: string, pageSize = 14) {
  let list = await localMovieList();
  if (search) list = searchCatalog("local:movie", list, search) as any[];
  const offset = (Math.max(1, page) - 1) * pageSize;
  const data = list.slice(offset, offset + pageSize);
  return { success: true, page, pageAtaTime: 1, total_items: list.length, actual_length: pageSize, total_loaded: data.length, data, errors: false, isPortal: false };
}

/** The files (versions) of one local title, best first, as playable file items. */
export async function localTitleFiles(titleId: string) {
  const itemId = Number(String(titleId).slice(1));
  const item = await LocalItem.findByPk(itemId);
  if (!item) return { success: true, page: 1, pageAtaTime: 1, total_items: 0, actual_length: 14, total_loaded: 0, data: [], errors: false, isPortal: false };
  const [base] = await itemsWithMeta([item]);
  const files = (await MediaFile.findAll({ where: { itemId, missingSince: null } })).sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (RES_ORDER[b.versionLabel ?? ""] ?? 0) - (RES_ORDER[a.versionLabel ?? ""] ?? 0),
  );
  const data = files.map((f) => ({
    ...base,
    id: `LF${f.id}`,
    stream_id: `LF${f.id}`,
    // The version shown in pickers ("4K · HDR10", "Director's Cut · 1080p").
    variantLabel: qualityLabel(f) || "Local file",
    duration: f.duration ? Math.round(f.duration / 60) : base?.duration,
    container_extension: f.container || undefined,
    audio_tracks: (f.audioTracks ?? []).map((t) => ({ language: t.language ?? null, codec: t.codec, channels: t.channels ?? null, title: t.title ?? null })),
    subtitle_tracks: [
      ...(f.subtitleTracks ?? []).map((t) => ({ language: t.language ?? null, codec: t.codec, forced: Boolean(t.forced), embedded: true })),
      ...(f.sidecars ?? []).map((s) => ({ language: s.language, codec: s.format, forced: s.forced, embedded: false })),
    ],
  }));
  return { success: true, page: 1, pageAtaTime: 1, total_items: data.length, actual_length: 14, total_loaded: data.length, data, errors: false, isPortal: false };
}

/**
 * A play link for a local file: a stream token naming the file id, never its path. The webui
 * (`client=web`) gets the HLS browser fallback when the file needs it (content/library/remux.ts).
 */
export async function localPlayLink(fileId: string, userLabel: string, title?: string, client?: string): Promise<string | null> {
  const id = Number(String(fileId).slice(2));
  const file = await MediaFile.findByPk(id);
  if (!file || file.missingSince) return null;
  const episode = file.episode != null;
  const token = mintStreamToken(`local:${file.id}`, userLabel, undefined, {
    kind: episode ? "series" : "movie",
    label: title,
    category: LOCAL_CATEGORY_TITLE,
    itemType: episode ? "episode" : "movie",
    itemId: episode ? `LF${file.id}` : `L${file.itemId}`,
    hideable: false,
  });
  if (client === "web" && needsBrowserFallback(file)) return `/api/local/hls/index.m3u8?t=${token}&m3u8=1`;
  return `/api/local/stream?t=${token}`;
}

// ---- Series ----------------------------------------------------------------------------
//   GET /api/v2/series-groups                     -> "My Library" first, when a library has shows
//   GET /api/v2/series?category=local             -> pages of local shows (series_id "L<itemId>")
//   GET /api/v2/series?movieId=L<id>              -> seasons ("L<id>S<n>", Specials = season 0)
//   GET /api/v2/series?movieId=L<id>&seasonId=..  -> episodes; an episode's id IS its file id
//                                                    ("LF<fileId>"), so progress, resume and
//                                                    "next episode" work unchanged in the apps
//   GET /api/v2/movies?movieId=L<id>&episodeId=LF<n> -> that one file

export async function localSeriesCategory(): Promise<any | null> {
  const n = await LocalItem.count({ where: { kind: "series", missingSince: null } });
  if (n === 0) return null;
  return { id: LOCAL_CATEGORY, title: LOCAL_CATEGORY_TITLE, alias: LOCAL_CATEGORY, censored: 0, number: 0, type: "series", isLocal: true };
}

async function seriesWithMeta(items: LocalItem[]) {
  const contentIds = items.map((i) => localContentId(i.id, "series"));
  const metas = await ContentMeta.findAll({ where: { id: { [Op.in]: contentIds } } });
  const metaById = new Map(metas.map((m) => [m.id, m]));
  const genreRows = (await ContentGenre.findAll({ where: { contentId: { [Op.in]: contentIds } }, raw: true })) as any[];
  const genresById = new Map<string, string[]>();
  for (const g of genreRows) genresById.set(g.contentId, [...(genresById.get(g.contentId) ?? []), g.value]);
  const counts = new Map<number, number>();
  for (const f of await MediaFile.findAll({ where: { itemId: { [Op.in]: items.map((i) => i.id) }, missingSince: null }, attributes: ["itemId"] })) {
    counts.set(f.itemId, (counts.get(f.itemId) ?? 0) + 1);
  }
  return items
    .filter((i) => counts.has(i.id))
    .map((i) => {
      const meta = metaById.get(localContentId(i.id, "series"));
      const id = `L${i.id}`;
      return {
        id,
        series_id: id,
        num: i.id,
        name: meta?.trimmedName || meta?.name || i.name,
        title: meta?.trimmedName || meta?.name || i.name,
        category_id: LOCAL_CATEGORY,
        year: meta?.year || i.year || undefined,
        added: Math.floor(new Date(i.createdAt).getTime() / 1000),
        screenshot_uri: meta?.poster || undefined,
        backdrop_path: meta?.backdrop || undefined,
        backdrop_hd_path: meta?.backdropHd || undefined,
        description: meta?.overview || undefined,
        actors: meta?.cast || undefined,
        director: meta?.director || undefined,
        genres_str: (genresById.get(localContentId(i.id, "series")) ?? []).join(", ") || undefined,
        is_series: 1,
        is_local: 1,
        tagline: meta?.tagline || undefined,
        rating_mpaa: meta?.ageRating || undefined,
        runtime: meta?.runtime || undefined,
        studios: meta?.studios || undefined,
        premiered: meta?.premiered || undefined,
        logo_path: meta?.logo || undefined,
      };
    });
}

export async function localSeriesList(): Promise<any[]> {
  const items = await LocalItem.findAll({ where: { kind: "series", missingSince: null }, order: [["createdAt", "DESC"]] });
  return seriesWithMeta(items);
}

export async function localSeriesPage(page: number, search: string, pageSize = 14) {
  let list = await localSeriesList();
  if (search) list = searchCatalog("local:series", list, search) as any[];
  const offset = (Math.max(1, page) - 1) * pageSize;
  const data = list.slice(offset, offset + pageSize);
  return { success: true, page, pageAtaTime: 1, total_items: list.length, actual_length: pageSize, total_loaded: data.length, data, errors: false, isPortal: false };
}

const emptyPage = () => ({ success: true, page: 1, pageAtaTime: 1, total_items: 0, actual_length: 14, total_loaded: 0, data: [] as any[], errors: false, isPortal: false });

/** The best file per episode of one show (two copies of S01E02: the larger picture wins). */
async function episodeFiles(itemId: number): Promise<MediaFile[]> {
  const files = await MediaFile.findAll({ where: { itemId, missingSince: null } });
  const best = new Map<string, MediaFile>();
  for (const f of files) {
    if (f.episode == null) continue;
    const key = `${f.season ?? 1}:${f.episode}`;
    const cur = best.get(key);
    if (!cur || (f.height ?? 0) > (cur.height ?? 0)) best.set(key, f);
  }
  return [...best.values()].sort((a, b) => (a.season ?? 1) - (b.season ?? 1) || (a.episode ?? 0) - (b.episode ?? 0));
}

export async function localSeasons(seriesId: string) {
  const itemId = Number(String(seriesId).slice(1));
  const item = await LocalItem.findByPk(itemId);
  if (!item || item.kind !== "series") return emptyPage();
  const [show] = await seriesWithMeta([item]);
  const bySeason = new Map<number, number[]>();
  for (const f of await episodeFiles(itemId)) bySeason.set(f.season ?? 1, [...(bySeason.get(f.season ?? 1) ?? []), f.episode!]);
  const seasons = [...bySeason.keys()].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b)); // Specials last
  const data = seasons.map((n) => ({
    id: `L${itemId}S${n}`,
    name: n === 0 ? "Specials" : `Season ${n}`,
    number: n,
    season_number: n,
    is_season: 1,
    series_id: `L${itemId}`,
    series: bySeason.get(n),
    screenshot_uri: show?.screenshot_uri,
    category_id: LOCAL_CATEGORY,
  }));
  return { ...emptyPage(), total_items: data.length, total_loaded: data.length, data };
}

function episodeItem(f: MediaFile, seriesId: string, base: any) {
  const ep = f.episode!;
  const label = f.episodeEnd && f.episodeEnd > ep ? `Episodes ${ep}-${f.episodeEnd}` : `Episode ${ep}`;
  return {
    ...base,
    id: `LF${f.id}`,
    stream_id: `LF${f.id}`,
    series_id: seriesId,
    season_id: `${seriesId}S${f.season ?? 1}`,
    name: f.episodeTitle ? `${label}. ${f.episodeTitle}` : label,
    title: f.episodeTitle ? `${label}. ${f.episodeTitle}` : label,
    series_number: f.season ?? 1,
    episode_num: ep,
    episode_number: ep,
    is_episode: 1,
    is_series: 1,
    time: f.duration ? String(Math.round(f.duration / 60)) : undefined,
    duration: f.duration ? Math.round(f.duration / 60) : undefined,
    container_extension: f.container || undefined,
    variantLabel: qualityLabel(f) || "Local file",
    description: f.nfo?.plot || undefined,
    air_date: f.nfo?.premiered || undefined,
    rating: f.nfo?.rating ? String(f.nfo.rating) : undefined,
    director: f.nfo?.directors?.length ? f.nfo.directors.join(", ") : undefined,
    // The episode's own thumbnail (Jellyfin metadata/ folder) beats TMDB's still.
    ...(f.thumb ? { screenshot_uri: artMarker(`f${f.id}`, "still", Math.floor((f.mtimeMs || 0) / 1000)), local_still: 1 } : {}),
    audio_tracks: (f.audioTracks ?? []).map((t) => ({ language: t.language ?? null, codec: t.codec, channels: t.channels ?? null, title: t.title ?? null })),
    subtitle_tracks: [
      ...(f.subtitleTracks ?? []).map((t) => ({ language: t.language ?? null, codec: t.codec, forced: Boolean(t.forced), embedded: true })),
      ...(f.sidecars ?? []).map((s) => ({ language: s.language, codec: s.format, forced: s.forced, embedded: false })),
    ],
  };
}

export async function localEpisodes(seriesId: string, seasonId: string, page: number, pageSize = 14) {
  const itemId = Number(String(seriesId).slice(1));
  const m = /^L\d+S(\d+)$/.exec(String(seasonId));
  const item = await LocalItem.findByPk(itemId);
  if (!item || !m) return emptyPage();
  const season = Number(m[1]);
  const [show] = await seriesWithMeta([item]);
  const base = { category_id: LOCAL_CATEGORY, is_local: 1, screenshot_uri: show?.screenshot_uri, genres_str: show?.genres_str, year: show?.year };
  const all = (await episodeFiles(itemId)).filter((f) => (f.season ?? 1) === season).map((f) => episodeItem(f, `L${itemId}`, base));
  const offset = (Math.max(1, page) - 1) * pageSize;
  const data = all.slice(offset, offset + pageSize);
  return { ...emptyPage(), page, total_items: all.length, total_loaded: data.length, data };
}

/** One episode file, for the "resolve the file" call (movies?movieId=L<id>&episodeId=LF<n>). */
export async function localEpisodeFile(seriesId: string, fileId: string) {
  const f = await MediaFile.findByPk(Number(String(fileId).slice(2)));
  if (!f || f.missingSince || `L${f.itemId}` !== String(seriesId)) return emptyPage();
  const item = await LocalItem.findByPk(f.itemId);
  const [show] = item ? await seriesWithMeta([item]) : [undefined];
  const data = [episodeItem(f, String(seriesId), { category_id: LOCAL_CATEGORY, is_local: 1, screenshot_uri: show?.screenshot_uri })];
  return { ...emptyPage(), total_items: 1, total_loaded: 1, data };
}

/** Local titles matching a search, for the global Search (listed before IPTV results). */
export async function localSearch(kind: "movie" | "series", q: string): Promise<any[]> {
  if (!q.trim()) return [];
  const list = kind === "movie" ? await localMovieList() : await localSeriesList();
  return list.length ? (searchCatalog(`local:${kind}`, list, q) as any[]) : [];
}
