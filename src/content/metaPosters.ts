import { ContentMeta, ContentType } from "@/models/ContentMeta";
import { logger } from "@/infra/logger";

// Xtream list endpoints (get_vod_streams / get_series) only carry the portal's
// own image, while the web UI and Discover already show TMDB artwork (see
// enrichArtworkFromTmdb in routes/stalkerV2/shared.ts) — TMDB posters are
// sharper and consistent, and many portal entries have none at all. ContentMeta
// already holds a TMDB poster for most of the catalog (id = "movie_{stream_id}"
// / "series_{series_id}"), so lists can prefer it with no per-item TMDB call.
//
// TMDB URLs live on image.tmdb.org, which proxiedImageUrl() deliberately leaves
// alone (SAFE_ABSOLUTE_IMAGE_HOSTS) — players fetch them straight from TMDB and
// never depend on this server's /api/images/proxy or its public origin.
//
// The whole id → poster map is loaded with one query and kept in memory
// (~120k short strings) instead of a lookup per list item; a full-catalog
// get_vod_streams can return >100k items. Refreshed every TTL so newly
// enriched titles show up without a restart.
const TTL_MS = 10 * 60 * 1000;
const TMDB_IMAGE_PREFIX = "https://image.tmdb.org/";

const cache = new Map<ContentType, { loadedAt: number; posters: Map<string, string> }>();
const loading = new Map<ContentType, Promise<Map<string, string>>>();

async function getPosterMap(kind: ContentType): Promise<Map<string, string>> {
  const hit = cache.get(kind);
  if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit.posters;

  let pending = loading.get(kind);
  if (!pending) {
    pending = (async () => {
      const rows = (await ContentMeta.findAll({
        attributes: ["id", "poster"],
        where: { type: kind, source: "tmdb" },
        raw: true,
      })) as unknown as Array<{ id: string; poster: string | null }>;
      const posters = new Map<string, string>();
      for (const r of rows) {
        // `poster` can fall back to the portal's own image on non-TMDB rows;
        // only ever swap in a real TMDB URL.
        if (r.poster && r.poster.startsWith(TMDB_IMAGE_PREFIX)) posters.set(r.id, r.poster);
      }
      cache.set(kind, { loadedAt: Date.now(), posters });
      return posters;
    })().finally(() => loading.delete(kind));
    loading.set(kind, pending);
  }
  return pending;
}

// Returns copies of `items` with `field` (stream_icon for movies, cover for
// series) replaced by the TMDB poster where ContentMeta has one; items without
// a TMDB match keep the portal image. Never throws — on any DB error the list
// is returned untouched so a metadata problem can't break the player's catalog.
export async function preferTmdbPosters<T extends Record<string, any>>(
  items: T[],
  kind: ContentType,
  field: "stream_icon" | "cover",
): Promise<T[]> {
  try {
    const posters = await getPosterMap(kind);
    if (posters.size === 0) return items;
    const idField = kind === "movie" ? "stream_id" : "series_id";
    return items.map((item) => {
      const id = item[idField];
      if (id === undefined || id === null) return item;
      const poster = posters.get(`${kind}_${id}`);
      return poster ? { ...item, [field]: poster } : item;
    });
  } catch (err) {
    logger.warn({ err }, `[metaPosters] TMDB poster lookup failed for ${kind}; serving portal images`);
    return items;
  }
}
