// In-memory "All Movies" / "All Series" (category="*") catalog for /api/v2/movies|series.
//
// Before: every category="*" request (each page, each search keystroke) read every visible
// category's cached list (xtreamCache.getMany -> JSON.parse of ~85k items), spread-copied all of
// them, and ran applyPortalItemOverrides over the lot — which loads overrides with a
// `WHERE item_key IN (...)` per 500 keys, i.e. ~170 SQLite queries per request.
//
// Now one entry per (profile, type) holds:
//   raw     the concatenated cached rows, in genre order (shared, never mutated)
//   browse  raw with content-manager overrides applied (hidden / moved-out dropped, renames as
//           shallow copies, moved-in appended, sort_order applied) — exactly what
//           applyPortalItemOverrides(…, "*") produced, minus the per-page normalisation, which
//           callers now do on the 14 items of the page only
//   catOf   stream/series id -> the category it was found in (Discover's item-open lookup)
// A page is then O(page) (slice + normalise 14 items); a search is the existing ranked index
// (content/searchIndex.ts) plus an O(matches) in-memory override pass.
//
// Invalidation is a fingerprint compared on every request, O(visible genres):
//   - the visible genre keys, in order (readGenres + hidden genre overrides)
//   - xtreamCache's per-key write version of each of those keys (bumped by every set/delete
//     in this process, which is the only writer of those rows)
//   - the override generation (bumped by Sequelize hooks on any ContentOverride/GenreOverride
//     write, including broken-stream auto-hide)
import { warmSearchIndex } from "@/content/searchIndex";

import { readGenres } from "@/infra/storage";
import { xtreamCache, xtreamCacheKeyVersion } from "@/services/xtreamCache";
import { contentKey, getHiddenGenreIds, overridesGeneration, getAllContentOverrides } from "@/content/overrides";

export type CatalogType = "movie" | "series";

export interface CatalogUnion {
  fp: string;
  raw: any[];
  browse: any[];
  catOf: Map<string, string>;
}

const entries = new Map<string, CatalogUnion>();
const building = new Map<string, Promise<CatalogUnion>>();

const listKey = (type: CatalogType, genreId: string) =>
  type === "movie" ? `vod_streams_${genreId}` : `series_list_${genreId}`;
const itemIdOf = (type: CatalogType, item: any): string =>
  String(type === "movie" ? item.stream_id : item.series_id);
/** Override key exactly as applyPortalItemOverrides computes it (contentKey of parseInt(id)). */
const overrideKeyOf = (type: CatalogType, item: any): string =>
  contentKey(type, String(parseInt(itemIdOf(type, item))));

async function visibleKeys(type: CatalogType, profileId: number | undefined): Promise<string[]> {
  const genres = await readGenres(type, profileId);
  const hidden = await getHiddenGenreIds(type);
  return genres
    .filter((g: any) => g.id && g.id !== "*" && !hidden.has(String(g.id)))
    .map((g: any) => listKey(type, String(g.id)));
}

/**
 * Applies content-manager overrides to the whole "*" catalog. Same semantics as
 * applyPortalItemOverrides(items, type, "*", getSourceCache) — see content/overrides.ts.
 */
async function applyOverridesToUnion(type: CatalogType, raw: any[]): Promise<any[]> {
  const all = await getAllContentOverrides(type);
  if (all.size === 0) return raw;
  // Only overrides of items actually in the list take part (matters for sort_order detection).
  const map = new Map<string, any>();
  const result: any[] = [];
  const present = new Set<string>();
  for (const item of raw) {
    const key = overrideKeyOf(type, item);
    present.add(key.slice(type.length + 1));
    const ov = all.get(key);
    if (!ov) { result.push(item); continue; }
    map.set(key, ov);
    if (ov.hidden) continue;
    if (ov.target_category_id && ov.target_category_id !== "*") continue;
    result.push(ov.display_name ? { ...item, name: ov.display_name } : item);
  }
  // Items moved INTO "*" (rare, but applyPortalItemOverrides supported it).
  for (const ov of all.values()) {
    if (ov.target_category_id !== "*" || ov.hidden || !ov.original_category_id) continue;
    const itemId = String(ov.item_key).replace(`${type}_`, "");
    if (present.has(itemId)) continue;
    const src = (await xtreamCache.get<any[]>(listKey(type, ov.original_category_id))) ?? [];
    const srcItem = src.find((i: any) => itemIdOf(type, i) === itemId);
    if (!srcItem) continue;
    result.push({ ...srcItem, id: itemId, name: ov.display_name ?? srcItem.name });
    map.set(contentKey(type, itemId), ov);
  }
  let hasSortOrder = false;
  for (const ov of map.values()) if (ov.sort_order != null) { hasSortOrder = true; break; }
  if (hasSortOrder) {
    const order = (i: any) => map.get(overrideKeyOf(type, i))?.sort_order ?? Infinity;
    result.sort((a, b) => order(a) - order(b));
  }
  return result;
}

/** The "*" catalog for `type`, rebuilt only when its fingerprint changed. Null when empty. */
export async function getCatalogUnion(type: CatalogType, profileId: number | undefined): Promise<CatalogUnion | null> {
  const keys = await visibleKeys(type, profileId);
  const fp = `${overridesGeneration()}|${keys.map((k) => `${k}@${xtreamCacheKeyVersion(k)}`).join(",")}`;
  const slot = `${profileId ?? 0}:${type}`;
  const have = entries.get(slot);
  if (have && have.fp === fp) return have.raw.length > 0 ? have : null;

  const buildKey = `${slot}|${fp}`;
  let p = building.get(buildKey);
  if (!p) {
    p = (async () => {
      const cachedByKey = await xtreamCache.getMany<any[]>(keys);
      const raw: any[] = [];
      const catOf = new Map<string, string>();
      for (const key of keys) {
        const list = cachedByKey.get(key);
        if (!list) continue;
        const cat = key.slice(type === "movie" ? "vod_streams_".length : "series_list_".length);
        for (const item of list) {
          raw.push(item);
          const id = itemIdOf(type, item);
          if (!catOf.has(id)) catOf.set(id, cat);
        }
      }
      const entry: CatalogUnion = { fp, raw, browse: await applyOverridesToUnion(type, raw), catOf };
      entries.set(slot, entry);
      // Index it for search now, not on the next search (routes search it as "<type>:*").
      if (raw.length) warmSearchIndex(`${type}:*`, raw);
      return entry;
    })().finally(() => building.delete(buildKey));
    building.set(buildKey, p);
  }
  const entry = await p;
  return entry.raw.length > 0 ? entry : null;
}

/**
 * Search-result override pass: same as applyPortalItemOverrides(…, "*", …, { searching: true })
 * — drop hidden and moved-out items, apply renames, keep the ranked order. O(matches).
 */
export async function applyOverridesToMatches(type: CatalogType, matches: any[]): Promise<any[]> {
  const all = await getAllContentOverrides(type);
  if (all.size === 0) return matches;
  const out: any[] = [];
  for (const item of matches) {
    const ov = all.get(overrideKeyOf(type, item));
    if (!ov) { out.push(item); continue; }
    if (ov.hidden) continue;
    if (ov.target_category_id && ov.target_category_id !== "*") continue;
    out.push(ov.display_name ? { ...item, name: ov.display_name } : item);
  }
  return out;
}
