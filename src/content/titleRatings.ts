// One title, one set of data: every version of a title ("ABC HD", "ABC - Hindi", "ABC Dub")
// shares a groupKey, and they all show the same rating and details, taken from the group as
// a whole (the representative row first, then any other version that has the field).
// Discover cards and the Movies / Series sections both use this, so a title shows the same
// rating wherever it is opened.

import { Op } from "sequelize";
import { ContentMeta } from "@/models/ContentMeta";

/**
 * The single rating a title shows: IMDb's (20+ votes; the most voters and the score people
 * know), else TMDB's (5+ votes), else TVmaze's for a series TMDB does not know. A score from
 * a handful of votes says little, so none is better than that.
 */
export function bestRating(row: any): { rating_best?: string; rating_source?: string } {
  if (row.imdbRating > 0 && (row.imdbVotes ?? 0) >= 20) return { rating_best: Number(row.imdbRating).toFixed(1), rating_source: "IMDb" };
  if (row.tmdbId && row.rating > 0 && (row.ratingCount ?? 0) >= 5) return { rating_best: Number(row.rating).toFixed(1), rating_source: "TMDB" };
  if (!row.tmdbId && row.rating > 0) return { rating_best: Number(row.rating).toFixed(1), rating_source: "TVmaze" };
  return {};
}

/** Rating fields as clients read them (Discover cards and catalog items alike). */
export function ratingFields(row: any): Record<string, any> {
  return {
    ...bestRating(row),
    imdb_id: row.imdbId || undefined,
    // Critics' scores beside the main rating on detail pages (OMDb; mostly Western titles).
    rt_rating: row.rtRating || undefined,
    metascore: row.metascore || undefined,
  };
}

const SHARED = ["tmdbId", "imdbId", "imdbRating", "imdbVotes", "rating", "ratingCount", "rtRating", "metascore", "overview", "cast", "director"] as const;

/**
 * Group data for content ids ("movie_123", "series_45"): the fields above, merged across
 * every version in each id's group. Ids not in content_meta are left out. Two indexed
 * queries per call (id, then groupKey).
 */
export async function groupDataFor(contentIds: string[]): Promise<Map<string, Record<string, any>>> {
  const out = new Map<string, Record<string, any>>();
  const ids = [...new Set(contentIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const own = (await ContentMeta.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id", "groupKey"], raw: true })) as any[];
  const keys = [...new Set(own.map((r) => r.groupKey).filter(Boolean))];
  if (keys.length === 0) return out;
  const members = (await ContentMeta.findAll({
    where: { groupKey: { [Op.in]: keys } },
    attributes: ["groupKey", "isRepresentative", ...SHARED],
    raw: true,
  })) as any[];
  const byGroup = new Map<string, any[]>();
  for (const m of members) {
    const list = byGroup.get(m.groupKey) ?? [];
    list.push(m);
    byGroup.set(m.groupKey, list);
  }
  const merged = new Map<string, Record<string, any>>();
  for (const [key, list] of byGroup) {
    list.sort((a, b) => Number(!!b.isRepresentative) - Number(!!a.isRepresentative));
    const data: Record<string, any> = {};
    // Rating pairs stay together (a rating with another version's vote count would lie).
    const firstWith = (f: string) => list.find((m) => m[f] != null && m[f] !== "");
    const imdb = list.find((m) => m.imdbRating > 0);
    const tmdb = list.find((m) => m.rating > 0);
    data.imdbRating = imdb?.imdbRating ?? null;
    data.imdbVotes = imdb?.imdbVotes ?? null;
    data.rating = tmdb?.rating ?? null;
    data.ratingCount = tmdb?.ratingCount ?? null;
    data.tmdbId = (tmdb ?? firstWith("tmdbId"))?.tmdbId ?? null;
    for (const f of ["imdbId", "rtRating", "metascore", "overview", "cast", "director"]) data[f] = firstWith(f)?.[f] ?? null;
    merged.set(key, data);
  }
  for (const r of own) {
    const data = merged.get(r.groupKey);
    if (data) out.set(r.id, data);
  }
  return out;
}
