import { GenreOverride } from "@/models/GenreOverride";
import { ContentOverride } from "@/models/ContentOverride";
import { GenreType } from "@/models/Genre";

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

export async function getHiddenGenreIds(type: GenreType): Promise<Set<string>> {
  const prefix = `${type}_`;
  const rows = await GenreOverride.findAll({ where: { hidden: true }, raw: true });
  return new Set(
    rows.filter((r) => r.genre_key.startsWith(prefix)).map((r) => r.genre_key.slice(prefix.length))
  );
}

// Apply to portal item arrays (browser stalkerV2): { id, name, ... }
// categoryId: when provided, filters items moved to a different category and (with getSourceCache) pulls in moved-in items
export async function applyPortalItemOverrides(
  items: any[],
  type: "movie" | "series",
  categoryId?: string | null,
  getSourceCache?: (catId: string) => Promise<any[]>,
): Promise<any[]> {
  if (items.length === 0 && !(categoryId && getSourceCache)) return items;
  const map = items.length > 0
    ? await loadContentOverrides(items.map((i) => contentKey(type, String(parseInt(i.id)))))
    : new Map<string, any>();

  let result = items
    .filter((i) => {
      const ov = map.get(contentKey(type, String(parseInt(i.id))));
      if (ov?.hidden) return false;
      if (categoryId && ov?.target_category_id && ov.target_category_id !== categoryId) return false;
      return true;
    })
    .map((i) => {
      const ov = map.get(contentKey(type, String(parseInt(i.id))));
      return ov?.display_name ? { ...i, name: ov.display_name } : i;
    });

  if (categoryId && getSourceCache) {
    const movedIn = await ContentOverride.findAll({
      where: { item_type: type, target_category_id: categoryId },
      raw: true,
    });
    const existingIds = new Set(result.map((i: any) => String(parseInt(i.id))));
    for (const ov of movedIn) {
      if (ov.hidden) continue;
      const itemId = ov.item_key.replace(`${type}_`, "");
      if (existingIds.has(itemId)) continue;
      if (!ov.original_category_id) continue;
      const srcItems = await getSourceCache(ov.original_category_id);
      const srcItem = type === "movie"
        ? srcItems.find((i: any) => String(i.stream_id) === itemId)
        : srcItems.find((i: any) => String(i.series_id) === itemId);
      if (!srcItem) continue;
      result.push({ ...srcItem, id: itemId, name: ov.display_name ?? srcItem.name });
      map.set(contentKey(type, itemId), ov);
    }
  }

  const hasSortOrder = [...map.values()].some((ov) => ov.sort_order != null);
  if (hasSortOrder) {
    result.sort((a, b) => {
      const aOrder = map.get(contentKey(type, String(parseInt(a.id))))?.sort_order ?? Infinity;
      const bOrder = map.get(contentKey(type, String(parseInt(b.id))))?.sort_order ?? Infinity;
      return aOrder - bOrder;
    });
  }

  return result;
}

// ── Hidden movie/series keys for Discover ───────────────────────────────────
// Discover reads ContentMeta, whose ids use the same "{type}_{id}" format as
// ContentOverride.item_key, so a hidden override can be excluded straight in the
// query. Before this, Discover ignored `hidden` entirely: titles an admin hid,
// or that broken-stream tracking auto-hid, still showed up there.
let hiddenKeysCache: { keys: string[]; at: number } | null = null;
const HIDDEN_KEYS_TTL_MS = 60_000;

export async function getHiddenContentKeys(): Promise<string[]> {
  if (hiddenKeysCache && Date.now() - hiddenKeysCache.at < HIDDEN_KEYS_TTL_MS) return hiddenKeysCache.keys;
  const rows = await ContentOverride.findAll({
    where: { hidden: true, item_type: ["movie", "series"] },
    attributes: ["item_key"],
    raw: true,
  }) as unknown as { item_key: string }[];
  hiddenKeysCache = { keys: rows.map((r) => r.item_key), at: Date.now() };
  return hiddenKeysCache.keys;
}

/** Call after any hide/unhide so Discover reflects it immediately. */
export function invalidateHiddenContentKeys(): void {
  hiddenKeysCache = null;
}

