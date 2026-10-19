import { GenreOverride } from "@/models/GenreOverride";
import { ContentOverride } from "@/models/ContentOverride";
import { GenreType } from "@/models/Genre";

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

export function genreKey(type: GenreType, id: string): string {
  return `${type}_${id}`;
}

export function contentKey(type: string, id: string | number): string {
  return `${type}_${id}`;
}

async function loadGenreOverrides(keys: string[]): Promise<Map<string, any>> {
  if (keys.length === 0) return new Map();
  const rows = await GenreOverride.findAll({ where: { genre_key: keys }, raw: true });
  return new Map(rows.map((r) => [r.genre_key, r]));
}

async function loadVirtualGenres(type: GenreType): Promise<Array<{ id: string; title: string; sort_order: number | null }>> {
  const prefix = `${type}_`;
  const rows = await GenreOverride.findAll({ where: { virtual: true }, raw: true });
  return rows
    .filter((r) => r.genre_key.startsWith(prefix))
    .map((r) => ({
      id: r.genre_key.slice(prefix.length),
      title: r.virtual_title ?? r.genre_key,
      sort_order: r.sort_order,
    }));
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
  const map = genres.length > 0
    ? await loadGenreOverrides(genres.map((g) => genreKey(type, String(g.id))))
    : new Map();

  let filtered = genres
    .filter((g) => !map.get(genreKey(type, String(g.id)))?.hidden)
    .map((g) => {
      const ov = map.get(genreKey(type, String(g.id)));
      return ov?.display_name ? { ...g, title: ov.display_name } : g;
    });

  const virtuals = await loadVirtualGenres(type);
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
  const hit = hiddenGenreCache.get(type);
  if (hit && hit.gen === gen) return new Set(hit.ids);
  const prefix = `${type}_`;
  const rows = await GenreOverride.findAll({ where: { hidden: true }, raw: true });
  const ids = new Set(
    rows.filter((r) => r.genre_key.startsWith(prefix)).map((r) => r.genre_key.slice(prefix.length))
  );
  hiddenGenreCache.set(type, { gen, ids });
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
