import { Op } from "sequelize";
import { GenreOverride } from "@/models/GenreOverride";
import { ContentOverride } from "@/models/ContentOverride";
import { SystemConfig } from "@/models/SystemConfig";
import { GenreType } from "@/models/Genre";
import { getActiveProfileId } from "@/routes/stalkerV2/shared";
import { logger } from "@/infra/logger";

// ── Override generation ─────────────────────────────────────────────────────
// Bumped by Sequelize hooks on every ContentOverride / GenreOverride write (content manager,
// broken-stream auto-hide, …), so in-memory views derived from overrides — the "*" catalog in
// content/catalogUnion.ts, the hidden-genre set and the per-type override map below — can be
// validated with an integer compare instead of a query. Hooks are attached lazily on first use
// because the models are only initialised once initDB() has run.
let overridesGen = 0;
let hooksAttached = false;
const OVERRIDE_HOOKS = [
  "afterCreate", "afterUpdate", "afterSave", "afterUpsert", "afterDestroy",
  "afterBulkCreate", "afterBulkUpdate", "afterBulkDestroy",
] as const;

function attachHooks(): void {
  if (hooksAttached) return;
  hooksAttached = true;
  const bump = () => { overridesGen++; };
  for (const model of [ContentOverride, GenreOverride] as any[]) {
    for (const hook of OVERRIDE_HOOKS) model.addHook(hook, `overridesGen_${hook}`, bump);
  }
}

export function overridesGeneration(): number {
  attachHooks();
  return overridesGen;
}

const allOverridesCache = new Map<string, { gen: number; map: Map<string, any> }>();

/** Every ContentOverride row of `type`, keyed by item_key — one query per override change. */
export async function getAllContentOverrides(type: string): Promise<Map<string, any>> {
  const gen = overridesGeneration();
  const hit = allOverridesCache.get(type);
  if (hit && hit.gen === gen) return hit.map;
  const rows = await ContentOverride.findAll({ where: { item_type: type }, raw: true });
  const map = new Map<string, any>(rows.map((r: any) => [r.item_key, r]));
  allOverridesCache.set(type, { gen, map });
  return map;
}

/**
 * The key of a category's override: "p3:movie_42" for provider profile 3 (owner 2026-11-04:
 * each provider has its own categories). Without a profile, "movie_42": the form older
 * servers wrote, for every profile (moved to the active profile once, moveGenreOverridesToProfile).
 * "vod_42" rows hold what provider category 42 holds (both lists share the provider's ids).
 */
export function genreKey(type: GenreType | "vod", id: string, profileId?: number | null): string {
  return `${profileId != null ? `p${profileId}:` : ""}${type}_${id}`;
}

/** The provider profile whose category overrides apply now: the active one. */
export async function overridesProfile(): Promise<number | null> {
  return (await getActiveProfileId()) ?? null;
}

/** What a provider category holds, as the admin set it. */
export type CategoryHolds = "movie" | "series" | "both";
export function isCategoryHolds(v: unknown): v is CategoryHolds {
  return v === "movie" || v === "series" || v === "both";
}

const holdsCache = new Map<string, { gen: number; map: Map<string, CategoryHolds> }>();

/** Provider category id -> what the admin said it holds, for this profile. */
export async function categoryHolds(profileId?: number | null): Promise<Map<string, CategoryHolds>> {
  const pid = profileId === undefined ? await overridesProfile() : profileId;
  if (pid == null) return new Map();
  const gen = overridesGeneration();
  const hit = holdsCache.get(String(pid));
  if (hit && hit.gen === gen) return hit.map;
  const prefix = `p${pid}:vod_`;
  const rows = await GenreOverride.findAll({ where: { genre_key: { [Op.like]: `${prefix}%` } }, raw: true });
  const map = new Map<string, CategoryHolds>();
  for (const r of rows as any[]) if (isCategoryHolds(r.holds)) map.set(r.genre_key.slice(prefix.length), r.holds);
  holdsCache.set(String(pid), { gen, map });
  return map;
}

const MOVE_FLAG = "genre_overrides_per_profile";

/**
 * Once: category overrides written before they were per profile ("movie_42") become the
 * active profile's ("p1:movie_42"): they were made for the provider in use. Until it has run
 * (or with no active profile) the old rows still apply, as before.
 */
export async function moveGenreOverridesToProfile(): Promise<void> {
  if ((await SystemConfig.findByPk(MOVE_FLAG))?.value) return;
  const pid = await overridesProfile();
  if (pid == null) return;
  const rows = await GenreOverride.findAll({ where: { genre_key: { [Op.notLike]: "p%:%" } } });
  let moved = 0;
  for (const row of rows) {
    const key = `p${pid}:${row.genre_key}`;
    if (!(await GenreOverride.findByPk(key))) {
      const { genre_key: _old, createdAt: _c, updatedAt: _u, ...fields } = row.get({ plain: true }) as any;
      await GenreOverride.create({ ...fields, genre_key: key });
      moved++;
    }
    await row.destroy();
  }
  await SystemConfig.upsert({ key: MOVE_FLAG, value: true });
  if (rows.length) logger.info(`[overrides] ${moved} category override(s) now belong to profile ${pid}`);
}

export function contentKey(type: string, id: string | number): string {
  return `${type}_${id}`;
}

/**
 * The overrides of these categories for the profile, keyed "movie_42" (the profile's row, else
 * an older one written for every profile).
 */
export async function loadGenreOverrides(type: GenreType, ids: string[], profileId: number | null): Promise<Map<string, any>> {
  if (ids.length === 0) return new Map();
  const keys = ids.flatMap((id) => (profileId != null ? [genreKey(type, id, profileId), genreKey(type, id)] : [genreKey(type, id)]));
  const rows = await GenreOverride.findAll({ where: { genre_key: keys }, raw: true });
  const own = new Map<string, any>(), old = new Map<string, any>();
  const prefix = profileId != null ? `p${profileId}:` : null;
  for (const r of rows as any[]) {
    if (prefix && r.genre_key.startsWith(prefix)) own.set(r.genre_key.slice(prefix.length), r);
    else old.set(r.genre_key, r);
  }
  const out = new Map<string, any>();
  for (const id of ids) {
    const k = genreKey(type, id);
    const r = own.get(k) ?? old.get(k);
    if (r) out.set(k, r);
  }
  return out;
}

/** The profile's own categories (and older ones for every profile it has no own row for). */
export async function loadVirtualGenres(type: GenreType, profileId: number | null): Promise<Array<{ id: string; title: string; sort_order: number | null }>> {
  const own = profileId != null ? `p${profileId}:${type}_` : null;
  const old = `${type}_`;
  const rows = await GenreOverride.findAll({ where: { virtual: true }, raw: true });
  const byId = new Map<string, { id: string; title: string; sort_order: number | null; own: boolean }>();
  for (const r of rows as any[]) {
    const isOwn = !!own && r.genre_key.startsWith(own);
    if (!isOwn && !r.genre_key.startsWith(old)) continue;
    const id = r.genre_key.slice((isOwn ? own! : old).length);
    if (byId.get(id)?.own) continue;
    byId.set(id, { id, title: r.virtual_title ?? r.genre_key, sort_order: r.sort_order, own: isOwn });
  }
  return [...byId.values()].map(({ own: _o, ...v }) => v);
}

// SQLite has a hard limit on bound parameters per query (historically 999) — a single
// `WHERE item_key IN (...)` with a large category's full item list (thousands of keys)
// can exceed that and fail outright. Chunk it so category size can never break this.
const OVERRIDE_QUERY_CHUNK = 500;

async function loadContentOverrides(keys: string[]): Promise<Map<string, any>> {
  if (keys.length === 0) return new Map();
  const rows: any[] = [];
  for (let i = 0; i < keys.length; i += OVERRIDE_QUERY_CHUNK) {
    const chunk = keys.slice(i, i + OVERRIDE_QUERY_CHUNK);
    const chunkRows = await ContentOverride.findAll({ where: { item_key: chunk }, raw: true });
    rows.push(...chunkRows);
  }
  return new Map(rows.map((r) => [r.item_key, r]));
}

function sortByOrder<T>(items: T[], getKey: (item: T) => string, map: Map<string, any>): T[] {
  const hasSortOrder = [...map.values()].some((ov) => ov.sort_order != null);
  if (!hasSortOrder) return items;
  return [...items].sort((a, b) => {
    const aOrder = map.get(getKey(a))?.sort_order ?? Infinity;
    const bOrder = map.get(getKey(b))?.sort_order ?? Infinity;
    return aOrder - bOrder;
  });
}

// Apply to DB genre arrays: { id, title, ... }
export async function applyGenreOverrides(genres: any[], type: GenreType): Promise<any[]> {
  const pid = await overridesProfile();
  const map = genres.length > 0
    ? await loadGenreOverrides(type, genres.map((g) => String(g.id)), pid)
    : new Map();

  let filtered = genres
    .filter((g) => !map.get(genreKey(type, String(g.id)))?.hidden)
    .map((g) => {
      const ov = map.get(genreKey(type, String(g.id)));
      return ov?.display_name ? { ...g, title: ov.display_name } : g;
    });

  const virtuals = await loadVirtualGenres(type, pid);
  const combinedMap = new Map(map);
  for (const v of virtuals) {
    filtered.push({ id: v.id, title: v.title });
    combinedMap.set(genreKey(type, v.id), { sort_order: v.sort_order });
  }

  return sortByOrder(filtered, (g) => genreKey(type, String(g.id)), combinedMap);
}

// Apply to channel DB arrays: { id, name, tv_genre_id, ... }
export async function applyChannelOverrides(channels: any[]): Promise<any[]> {
  if (channels.length === 0) return channels;
  const map = await loadContentOverrides(channels.map((c) => contentKey("channel", c.id)));
  return channels
    .filter((c) => !map.get(contentKey("channel", c.id))?.hidden)
    .map((c) => {
      const ov = map.get(contentKey("channel", c.id));
      if (!ov) return c;
      return {
        ...c,
        name: ov.display_name ?? c.name,
        tv_genre_id: ov.target_category_id ?? c.tv_genre_id,
      };
    });
}

const hiddenGenreCache = new Map<string, { gen: number; ids: Set<string> }>();

export async function getHiddenGenreIds(type: GenreType): Promise<Set<string>> {
  const gen = overridesGeneration();
  const pid = await overridesProfile();
  const cacheKey = `${pid ?? ""}|${type}`;
  const hit = hiddenGenreCache.get(cacheKey);
  if (hit && hit.gen === gen) return new Set(hit.ids);
  // The profile's own rows decide; an older row for every profile counts where it has none.
  const own = pid != null ? `p${pid}:${type}_` : null;
  const old = `${type}_`;
  const rows = await GenreOverride.findAll({
    where: { genre_key: { [Op.or]: [{ [Op.like]: `${old}%` }, ...(own ? [{ [Op.like]: `${own}%` }] : [])] } },
    raw: true,
  });
  const decided = new Map<string, { hidden: boolean; own: boolean }>();
  for (const r of rows as any[]) {
    const isOwn = !!own && r.genre_key.startsWith(own);
    const id = r.genre_key.slice((isOwn ? own! : old).length);
    if (decided.get(id)?.own) continue;
    decided.set(id, { hidden: !!r.hidden, own: isOwn });
  }
  const ids = new Set([...decided].filter(([, d]) => d.hidden).map(([id]) => id));
  hiddenGenreCache.set(cacheKey, { gen, ids });
  return new Set(ids);
}

// Apply to portal item arrays (browser stalkerV2): { id, name, ... }
// categoryId: when provided, filters items moved to a different category and (with getSourceCache) pulls in moved-in items
export async function applyPortalItemOverrides(
  items: any[],
  type: "movie" | "series",
  categoryId?: string | null,
  getSourceCache?: (catId: string) => Promise<any[]>,
  /** Search results: keep the ranked order and don't append moved-in items (they were never matched against the query). */
  opts: { searching?: boolean } = {},
): Promise<any[]> {
  if (items.length === 0 && !(categoryId && getSourceCache) ) return items;
  // Every override of this type, from memory (rebuilt only when an override changes).
  // Previously: one `item_key IN (…)` query per 500 items on every call — ~200 ms for a
  // 20k-title category on the live data, for a page of 14.
  const all = await getAllContentOverrides(type);
  const keyOf = (id: any) => contentKey(type, String(parseInt(id)));
  const used = new Map<string, any>(); // overrides that apply to the returned items

  let result: any[] = [];
  for (const i of items) {
    const key = keyOf(i.id);
    const ov = all.get(key);
    if (!ov) { result.push(i); continue; }
    if (ov.hidden) continue;
    if (categoryId && ov.target_category_id && ov.target_category_id !== categoryId) continue;
    used.set(key, ov);
    result.push(ov.display_name ? { ...i, name: ov.display_name } : i);
  }

  if (categoryId && getSourceCache && !opts.searching && all.size > 0) {
    const existingIds = new Set(result.map((i: any) => String(parseInt(i.id))));
    for (const ov of all.values()) {
      if (ov.target_category_id !== categoryId || ov.hidden || !ov.original_category_id) continue;
      const itemId = ov.item_key.replace(`${type}_`, "");
      if (existingIds.has(itemId)) continue;
      const srcItems = await getSourceCache(ov.original_category_id);
      const srcItem = type === "movie"
        ? srcItems.find((i: any) => String(i.stream_id) === itemId)
        : srcItems.find((i: any) => String(i.series_id) === itemId);
      if (!srcItem) continue;
      result.push({ ...srcItem, id: itemId, name: ov.display_name ?? srcItem.name });
      used.set(contentKey(type, itemId), ov);
    }
  }

  let hasSortOrder = false;
  for (const ov of used.values()) if (ov.sort_order != null) { hasSortOrder = true; break; }
  if (hasSortOrder && !opts.searching) {
    const orderOf = (x: any) => used.get(keyOf(x.id))?.sort_order ?? Infinity;
    result = result
      .map((x, idx) => ({ x, o: orderOf(x), idx }))
      .sort((a, b) => (a.o - b.o) || (a.idx - b.idx))
      .map((e) => e.x);
  }

  return result;
}

// ── Hidden movie/series keys for Discover ───────────────────────────────────
// Discover reads ContentMeta, whose ids use the same "{type}_{id}" format as
// ContentOverride.item_key, so a hidden override can be excluded straight in the
// query. Before this, Discover ignored `hidden` entirely: titles an admin hid,
// or that broken-stream tracking auto-hid, still showed up there.
// Cached per override generation (bumped by the ContentOverride hooks above), so a
// hide/unhide is visible on the very next request and nothing is re-queried otherwise.
let hiddenKeysCache: { gen: number; keys: string[]; set: Set<string> } | null = null;

async function loadHiddenKeys(): Promise<{ keys: string[]; set: Set<string> }> {
  const gen = overridesGeneration();
  if (hiddenKeysCache && hiddenKeysCache.gen === gen) return hiddenKeysCache;
  const rows = await ContentOverride.findAll({
    where: { hidden: true, item_type: ["movie", "series"] },
    attributes: ["item_key"],
    raw: true,
  }) as unknown as { item_key: string }[];
  const keys = rows.map((r) => r.item_key);
  hiddenKeysCache = { gen, keys, set: new Set(keys) };
  return hiddenKeysCache;
}

export async function getHiddenContentKeys(): Promise<string[]> {
  return (await loadHiddenKeys()).keys;
}

/** Same as getHiddenContentKeys, as a Set for O(1) membership checks. Do not mutate. */
export async function getHiddenContentKeySet(): Promise<Set<string>> {
  return (await loadHiddenKeys()).set;
}

/** Call after any hide/unhide so Discover reflects it immediately. */
export function invalidateHiddenContentKeys(): void {
  hiddenKeysCache = null;
}
