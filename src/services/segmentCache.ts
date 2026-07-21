import NodeCache from "node-cache";

// Shared live-TV segment cache used by both provider paths (src/routes/live.ts
// for Stalker/generic, src/services/LiveStreamService.ts for Xtream). Keyed by
// "cmd<_>seq" — the channel command + sequence number, which is identical for
// every viewer of a given channel (confirmed: cmdPlayerV2/LiveStreamService's
// populateCache both key purely on the plain `cmd`, never anything per-user).
// So a segment fetched for one viewer is immediately reusable by any other
// viewer of the same channel requesting the same sequence number — this cache
// is what makes that sharing actually happen, instead of every viewer paying
// their own independent origin round-trip for identical bytes.
//
// Unlike the old per-file delete-on-read design this replaces, reads here
// never remove the entry — eviction is left entirely to the TTL/maxKeys sweep
// so multiple viewers (sequential or concurrent) can all be served the same
// cached bytes.
export type CachedSegment = { data: Buffer; contentType: string };

const TTL_SECONDS = 60;
const MAX_KEYS = 500;

const cache = new NodeCache({ stdTTL: TTL_SECONDS, checkperiod: 10, useClones: false, maxKeys: MAX_KEYS });

export function segmentKey(cmd: string, seq: number): string {
  return `${cmd}<_>${seq}`;
}

export function hasSegment(key: string): boolean {
  return cache.has(key);
}

// Kicks off (or reuses an already in-flight) fetch for `key`, storing the
// resulting Promise itself in the cache — callers awaiting the same key while
// the fetch is still in flight all resolve to the same result instead of
// triggering duplicate origin requests. Used both for read-ahead prefetch and
// to backfill the cache from a cold-miss direct fetch, so a segment fetched
// for the first viewer becomes available to the next one behind them.
export function primeSegment(key: string, fetcher: () => Promise<CachedSegment | undefined>): void {
  if (cache.has(key)) return;
  // On failure, evict this key immediately instead of letting the resolved-
  // to-undefined promise sit cached for the full TTL — otherwise one
  // transient upstream error disables sharing for this segment (every
  // subsequent viewer falls through to the non-shared raw-fetch fallback)
  // for up to a minute even after the origin recovers.
  const promise = fetcher().catch((err) => {
    cache.del(key);
    throw err;
  });
  try {
    // node-cache throws ECACHEFULL once maxKeys is hit — caching here is a
    // pure optimization, so just skip it rather than let that bubble up.
    cache.set(key, promise);
  } catch {
    // cache full; the segment will be fetched normally on request instead
  }
  // Swallow the rejection here so it doesn't surface as an unhandled
  // rejection — real callers observe it through readSegment()'s own await.
  promise.catch(() => undefined);
}

export async function readSegment(key: string): Promise<CachedSegment | undefined> {
  const pending = cache.get<Promise<CachedSegment | undefined>>(key);
  if (!pending) return undefined;
  return pending.catch(() => undefined);
}
