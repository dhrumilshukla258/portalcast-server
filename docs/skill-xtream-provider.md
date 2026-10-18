# Xtream Provider — Skill Reference

Covers `XtreamClient` (the server connecting to an Xtream Codes source as its content origin), `XtreamCache` (the SQLite catalog cache every `/api/v2` movie/series route reads), dual-portal detection, and the warm/catchup/sweep cycle. Key commits: `0d5cfbe`, `1bf9fe8`, `3dda72c`, `584ae8c`.

Related: [[skill-stalker-provider]], [[skill-content-lifecycle]], [[skill-content-manager]], [[skill-discover]], [[skill-stream-tokens]]

> **Scope note (2026-10-18).** This server used to *also* emulate the Xtream Codes API towards third-party IPTV players (TiviMate, Smarters), export M3U/XMLTV playlists, generate Jellyfin `.strm` files and append a version suffix to category IDs so free players would re-fetch. All of that was removed: `src/routes/xtream/`, `src/services/xtreamAuth.ts`, `src/providers/getM3uUrls.ts`, `src/content/strmGenerator.ts`, the `Strm*` models, and the `bumpVodVersion`/`addVer`/`stripVer` helpers in `src/services/xtreamCache.ts` no longer exist. Every client now logs in through the server's own user system and uses `/api/v2/*`. What's left — and what this doc covers — is only the **upstream provider** and its **cache**. If you need the old player-facing behaviour for reference, `ddf99fa` is the last commit that still has it.

---

## XtreamClient (`src/providers/xtream-client.ts`)

Implements `IProvider`. Connects to any Xtream Codes-compatible portal via its `player_api.php` endpoint (this is the *upstream* portal's API — the server is the client here).

### Constructor
Reads from `initialConfig`: `hostname`, `port`, `https`, `username`, `password`. Credentials come from the active `ConfigProfile` in DB, not from env vars.

### Request pipeline
1. Build cache key from sorted params (deterministic)
2. Check `NodeCache` (in-memory, 6h TTL) — return immediately on hit
3. Deduplicate in-flight: if same request is pending, return the existing promise (`inFlight` Map)
4. Circuit breaker check — if OPEN, immediately throws (avoids hammering a failing portal)
5. Fire `axios.get` to the portal's `player_api.php` with `VLC/3.0.16` User-Agent (maximizes portal compatibility)
6. On success: `breaker.recordSuccess()` + cache result; on failure: `breaker.recordFailure()` + clean up `inFlight`

### Key methods

| Method | Portal action | Notes |
|--------|--------------|-------|
| `getChannelGroups()` | `get_live_categories` | Maps to `Genre[]` |
| `getChannels()` | `get_live_streams` | Maps to `Channel[]`; `cmd` is the portal's own live URL, tokenized by `mapChannel()` before it reaches a client |
| `getChannelLink(cmd)` | — | Returns cmd as-is (the `/live.m3u8` route resolves/proxies it) |
| `getEPG(channelId)` | `get_short_epg` | Decodes Base64 titles |
| `getMovies({ category, page })` | `get_vod_streams` | Paginated |
| `getMovieInfo(id)` | `get_vod_info` | Returns metadata + stream URL |
| `getSeries({ category })` | `get_series` or `get_vod_streams` depending on portal type |
| `getSeriesInfo(id)` | `get_series_info` | Seasons + episodes |
| `clearCache()` | — | Flushes `NodeCache` in-memory |

### EPG title decoding
Xtream portals Base64-encode EPG titles. `decodeBase64Safe` and `decodeBase64Title` handle both standard and URL-safe variants, with a plain-text fallback.

---

## XtreamCache (`src/models/XtreamCache.ts` + `src/services/xtreamCache.ts`)

SQLite-backed persistent cache. TTL = **24 hours** (`TTL_MS`). Despite the name it is the catalog cache for *both* provider types' `/api/v2/movies`, `/api/v2/series`, the Content Manager item lists and Discover enrichment — do not treat it as Xtream-player-only leftovers.

### Cache object (exported from `src/services/xtreamCache.ts`)

```ts
xtreamCache.get<T>(key)           // Returns value or undefined
xtreamCache.getMany<T>(keys)      // Batched read
xtreamCache.getWithStaleness<T>(key)  // Returns { value, isStale }
xtreamCache.set(key, value)       // Upserts with 24h TTL
xtreamCache.delete(key)
```

### Cache key patterns

| Key | Contents |
|-----|---------|
| `vod_streams_{category_id}` | Movie list for a genre |
| `series_list_{category_id}` | Series list for a genre |
| `series_info_{series_id}` | Seasons and episodes |
| `vod_info_{stream_id}` | Movie metadata |
| `vod_cmd_{stream_id}` | Movie playback command |
| `ep_info_{episode_id}` | Episode metadata |
| `ep_cmd_{episode_id}` | Episode playback command |
| `tmdb_movie_{id}` / `tmdb_tv_{id}` | Cached TMDB lookups (shared with Discover enrichment, see [[skill-discover]]) |
| `portal_series_source` | `"native"` or `"mixed"` |

Wipe all entries via `DELETE /api/v2/clear-xtream-cache` — forces re-detection of portal type.

### `getOrRefreshVodStreams(categoryId)` / `getOrRefreshSeriesList(categoryId)`

Used by `/api/v2/movies` and `/api/v2/series` (`src/routes/stalkerV2/movies.ts`, `series.ts`). On a cache miss or stale entry, fetches from the portal, merges with the cached rows, and writes back.

**In-flight deduplication**: both functions are wrapped so only one refresh per `categoryId` is ever running at a time (`vodRefreshInFlight`/`seriesRefreshInFlight` maps, mirroring `StalkerAPI.makeRequest`'s own `inFlight` pattern). Without this, two concurrent calls for the same category — e.g. a double-fired category click on the frontend — each independently read the same stale snapshot, fetch, merge, and write back; whichever write lands last silently wins, discarding whatever the other one computed. Added after a user report of wrong content appearing under a category (network trace showed the same category request firing twice) — this closes the race, though the specific report turned out inconclusive as to root cause (portal-side data issue was the likelier explanation in that case).

---

## Mixed-Content vs Native-Series Portal Detection

Not "dual portal support" in the sense of running two portals — this is about **one portal's layout**: whether it exposes series through a separate API or crams them into the VOD list. Two layouts are auto-detected on first series warm and cached in `XtreamCache` under key `portal_series_source`:

**`"vod"` — Mixed-content portal**
- Movies and series share one `get_vod_streams` endpoint
- Items are split by the `{SERIES_FLAG}` field (default `is_series`; `1` = series). Only override the `SERIES_FLAG` env var if your portal names this field something else — most portals don't need this touched at all
- No dedicated series API exists on this portal

**`"native"` — Native series portal**
- Separate `get_series` / `get_series_categories` API
- `get_vod_streams` returns movies only; `SERIES_FLAG` is irrelevant here since there's nothing to split
- `portal_series_source` cached as `"native"`

Detection is triggered by `warmSeriesCache()` and written to `XtreamCache`. Clearing the cache forces re-detection. `isNativeSeriesSource()` memoizes the row for 5 s so request bursts share one DB read.

---

## Cache Warming

`warmVodCache()` and `warmSeriesCache()` run in parallel on startup and every 24 hours (`src/server.ts`):
1. Fetch portal pages until a known item is found (incremental — stops early)
2. Insert only new items; both functions return `true` when they found something new
3. Upsert genres from actual content; `cleanupGenres()` removes empty genres

`warmSeriesInfoCache()` pre-fetches all seasons/episodes for every cached series (500ms throttle between series to avoid portal hammering). `enrichContentMeta()` then runs for whatever is new ([[skill-discover]]).

### Catchup scan (`POST /api/v2/catchup-scan`)

Use after a long offline period. The incremental warm stops at the first known item, so gaps at the tail are missed. Catchup does full reconciliation per genre:

- **diff > 0** (portal has more): incremental scan from page 1; track `balance = new items found`; stop when `balance >= diff`. Also detects deletions from pages scanned via `seenPortalIds`.
- **diff < 0** (portal has fewer): scan ALL portal pages; build a complete ID set; filter local cache removing any item absent from portal; pick up any newly-added items too.
- **diff = 0**: skip (already in sync).

`fetchAllPages()` accepts an optional `startPage` parameter so already-fetched page 1 data can be reused.

### XtreamCache is never purged by age

Despite genuinely accumulating unbounded per-item rows over time (no scheduled job ever deletes an expired `vod_info_*`/`ep_info_*`/etc. row), `XtreamCache` is **deliberately excluded** from `runDbCleanup()` in `src/server.ts`. A 7-day-stale purge was tried and reverted after it broke production: even scoped to only `vod_streams_*`/`series_list_*` keys, an earlier unscoped version of it also deleted write-once rows like `series_info_*` — populated once by `warmSeriesInfoCache()` and never rewritten again once complete, so their `expiresAt` freezes at creation time and eventually crosses any age threshold regardless of the row still being actively read. Deleting them forced a full catalog rebuild on the next warm cycle. See [[skill-database#Scheduled Cleanup]] for the full incident writeup.

`runDbCleanup()` does still purge expired `device_codes` rows and stale `EpgCache` rows — simpler tables with no stale-serve/write-once pattern to worry about.

### `catchupScan()` — also used by the automatic stale-content sweep

Originally manual-only (`POST /api/v2/catchup-scan`, `src/routes/stalkerV2/maintenance.ts`): compares the portal's own reported `total_items` against the locally cached count per category, doing a cheap bounded incremental scan when the portal has more, and only paying for a full-page scan when the total has dropped (the only way to know exactly which ids are gone). It accepts an optional `CatchupScanOptions` (`genreIds`, `onRemoved`, `throttleMs`) so [[skill-content-lifecycle]]'s automatic sweep can reuse this same detection logic, scoped to a small rotating slice of categories and with the actually-removed ids fed to `pruneContentMeta()` — something `catchupScan()` itself still never does; called with no options (the manual endpoint's usage), its behavior is unchanged: full catalog, no throttle, updates only the `XtreamCache` list cache.

`catchupScan()` returns `Promise<boolean>` — `true` if it actually ran, `false` if it was skipped because another scan (manual or automatic) already held its single global in-progress mutex. The manual endpoint ignores this; the automatic sweep does not — see [[skill-content-lifecycle]] for why that distinction matters there.

---

## Artwork

`buildIconUrl()` stores the portal's **real** `stream_icon`/`cover` URL in the cache (our own DB, never sent to a client as-is). Conversion to a same-origin proxied URL (`/api/images/proxy?u=…`, `proxiedImageUrl` in `src/providers/portalAssets.ts`) happens at serve time in `mapChannel` / `enrichArtworkFromTmdb` (`src/routes/stalkerV2/shared.ts`), which also prefer the TMDB poster when `ContentMeta` has one — see [[skill-discover]]. TMDB URLs are on `image.tmdb.org`, which `proxiedImageUrl()` deliberately doesn't proxy.

---

## Key Files

- `src/providers/xtream-client.ts` — XtreamClient implementation (includes circuit breaker)
- `src/services/xtreamCache.ts` — XtreamCache object, `getOrRefresh*`, warm functions, `catchupScan()`, `cleanupGenres()`
- `src/models/XtreamCache.ts` — Sequelize model
- `src/routes/stalkerV2/movies.ts`, `series.ts`, `maintenance.ts` — the `/api/v2` consumers of the cache (browse, warm/catchup/clear endpoints)
- `src/streaming/circuitBreaker.ts` — Reusable `CircuitBreaker` class (configurable via `CB_*` env vars)
