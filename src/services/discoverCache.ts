import NodeCache from "node-cache";

// In-memory TTL cache for Discover's non-personalized queries (facets, browse).
// Unlike xtreamCache (which caches upstream-portal responses), this caches our
// own DB aggregation results — facets/browse are identical for every user (no
// personalization yet), so a single cached computation can serve every
// concurrent request until the next enrichment run invalidates it.
// `recommendations` is per-user and intentionally never cached here.
//
// NodeCache (not a plain Map) so expired-but-never-revisited keys (e.g. a
// one-off genre+page combination nobody browses to again) get swept by
// `checkperiod` instead of leaking until the next full clearDiscoverCache() —
// `maxKeys` also bounds worst-case memory if the filter-combination key space
// grows large.
const TTL_SECONDS = 10 * 60;

const cache = new NodeCache({ stdTTL: TTL_SECONDS, checkperiod: 60, useClones: false, maxKeys: 2000 });

export function getCached<T>(key: string): T | undefined {
  return cache.get<T>(key);
}

export function setCached<T>(key: string, value: T): void {
  try {
    cache.set(key, value);
  } catch {
    // cache full (maxKeys) — this is a pure optimization, so just skip
    // caching this entry rather than let it bubble up as an error.
  }
}

// Called once enrichContentMeta() finishes so facets/browse reflect fresh
// data immediately instead of waiting out the TTL — the TTL above just
// remains as a safety net for cases where invalidation is missed (e.g. a
// crash mid-enrichment).
export function clearDiscoverCache(): void {
  cache.flushAll();
}
