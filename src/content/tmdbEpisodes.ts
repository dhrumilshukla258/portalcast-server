// Episode stills, titles, descriptions and runtimes from TMDB for a season's episode
// list. Stalker portals send episodes as "Episode 13. Friends and Family" with the series
// poster (or nothing) as the still and no description; TMDB has a proper still, name,
// overview and runtime per episode, keyed by season and episode number.
//
// The season number is not in the episode request (clients send the portal's opaque
// seasonId), so it is remembered from the season list the client fetched just before
// (rememberSeasonNumbers) or sent explicitly as `seasonNumber`.

import { Op } from "sequelize";
import { ContentMeta } from "@/models/ContentMeta";
import { xtreamCache } from "@/services/xtreamCache";
import { fetchTvSeason, TmdbEpisode } from "@/content/tmdb";
import { proxiedImageUrl } from "@/providers/portalAssets";
import { logger } from "@/infra/logger";

// ---- season numbers ------------------------------------------------------------------
const MAX_REMEMBERED_SEASONS = 20_000;
const seasonNumbers = new Map<string, number>();
const SEASON_IN_NAME = /\bseason\s*:?\s*(\d{1,3})\b/i;

/** "Season 5. Kim's Convenience : Season 05" -> 5; null when the name carries no number. */
export function seasonNumberOf(item: any): number | null {
  const explicit = Number(item?.season_number ?? item?.number);
  if (explicit > 0) return explicit;
  const name = String(item?.name || item?.title || "");
  const m = SEASON_IN_NAME.exec(name);
  if (m) return Number(m[1]);
  const d = /(\d{1,3})\b/.exec(name);
  return d ? Number(d[1]) : null;
}

/** Called with a series' season list on the way out, so the episode request can be mapped. */
export function rememberSeasonNumbers(items: any[]): void {
  for (const item of items) {
    const id = item?.id;
    if (id == null) continue;
    const n = seasonNumberOf(item);
    if (!n) continue;
    if (seasonNumbers.size >= MAX_REMEMBERED_SEASONS) seasonNumbers.delete(seasonNumbers.keys().next().value as string);
    seasonNumbers.set(String(id), n);
  }
}

// ---- episode numbers (same rules as the TV app's EpisodeInfo) ------------------------
const SXXEYY = /\bS\d{1,2}\s*E(\d{1,4})\b/i;
const LEADING_EPISODE = /^\s*(?:episode|ep\.?|e)\s*(\d{1,4})\s*(?:[.:\-–—)]\s*)?/i;
const LEADING_NUMBER = /^\s*(\d{1,4})\s*[.:\-–—)]\s+/;

export function episodeNumberOf(item: any): number | null {
  const name = String(item?.name || item?.title || "");
  for (const re of [SXXEYY, LEADING_EPISODE, LEADING_NUMBER]) {
    const m = re.exec(name);
    if (m) return Number(m[1]);
  }
  const n = Number(item?.episode_num ?? item?.episode_number ?? item?.series_number);
  return n > 0 ? n : null;
}

/** The name without its "Episode 13." / "S01E13" / "13." prefix. */
function strippedTitle(name: string): string {
  return name
    .replace(SXXEYY, " ")
    .replace(LEADING_EPISODE, "")
    .replace(LEADING_NUMBER, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\-–—:.\s]+/, "");
}

/** True for titles that say nothing: empty, "Ep. 1294", a date ("25-07-2026"). */
function isPlaceholderTitle(stripped: string): boolean {
  return !stripped || /^[\d\s.\-–—:\/]+$/.test(stripped) || /^(?:ep\.?|episode)\s*\d+$/i.test(stripped);
}

// ---- TMDB lookups --------------------------------------------------------------------
async function tmdbIdForSeries(seriesId: string | number): Promise<number | null> {
  const row = (await ContentMeta.findByPk(`series_${seriesId}`, { attributes: ["tmdbId", "groupKey"], raw: true })) as any;
  if (row?.tmdbId) return Number(row.tmdbId);
  // A variant TMDB could not match itself ("Kim's Convenience 2016") shares its group
  // with one that was matched.
  if (row?.groupKey) {
    const sibling = (await ContentMeta.findOne({
      where: { groupKey: row.groupKey, tmdbId: { [Op.ne]: null } },
      attributes: ["tmdbId"],
      raw: true,
    })) as any;
    if (sibling?.tmdbId) return Number(sibling.tmdbId);
  }
  return null;
}

type SeasonCacheValue = TmdbEpisode[] | { _none: true };

async function seasonEpisodes(tmdbId: number, season: number): Promise<TmdbEpisode[] | null> {
  const key = `tmdb_tv_season_${tmdbId}_${season}`;
  const cached = await xtreamCache.get<SeasonCacheValue>(key);
  if (cached) return Array.isArray(cached) ? cached : null;
  const fetched = await fetchTvSeason(tmdbId, season);
  await xtreamCache.set(key, fetched && fetched.length > 0 ? fetched : { _none: true });
  return fetched && fetched.length > 0 ? fetched : null;
}

/**
 * Fills the episode items of one season from TMDB: a still when TMDB has one (portal
 * episode art is usually the series poster or blank), the description, runtime and, for
 * placeholder names ("Episode 6", a date), the episode title. Items TMDB does not list
 * (specials, mis-numbered) are returned as they are. Never throws: a TMDB problem just
 * leaves the portal's data.
 */
export async function withTmdbEpisodes(
  items: any[],
  seriesId: string | number,
  seasonId: string | number,
  seasonNumberHint: unknown,
  origin?: string,
): Promise<any[]> {
  if (!Array.isArray(items) || items.length === 0) return items;
  try {
    const season = Number(seasonNumberHint) > 0 ? Number(seasonNumberHint) : seasonNumbers.get(String(seasonId));
    if (!season) return items;
    const tmdbId = await tmdbIdForSeries(seriesId);
    if (!tmdbId) return items;
    const episodes = await seasonEpisodes(tmdbId, season);
    if (!episodes) return items;
    const byNumber = new Map(episodes.map((e) => [e.number, e]));

    return items.map((item) => {
      const n = episodeNumberOf(item);
      const e = n ? byNumber.get(n) : undefined;
      if (!e) return item;
      const name = String(item.name || item.title || "");
      const out: any = { ...item };
      if (e.still) out.screenshot_uri = proxiedImageUrl(e.still, origin);
      if (!String(item.description || "").trim() && e.overview) out.description = e.overview;
      if (e.name && isPlaceholderTitle(strippedTitle(name))) out.name = `Episode ${n}. ${e.name}`;
      if (!(Number(item.time) > 0) && e.runtime) out.time = String(e.runtime);
      if (e.airDate && !item.air_date) out.air_date = e.airDate;
      return out;
    });
  } catch (err: any) {
    logger.warn(`[tmdbEpisodes] series ${seriesId} season ${seasonId}: ${err?.message ?? err}`);
    return items;
  }
}
