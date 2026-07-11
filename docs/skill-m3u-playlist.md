# M3U Playlist Generation — Skill Reference

Covers how live M3U, VOD M3U, and EPG XML are built, cached, and served. Key file: `src/utils/getM3uUrls.ts`. Commits: `eddd29e`, `0d5cfbe`.

Related: [[skill-xtream-provider]], [[skill-stalker-provider]], [[skill-content-manager]], [[skill-stream-tokens]]

---

## Live M3U (`getM3uV2`)

Served at `GET /m3u` or as needed by connected players.

### Build pipeline
1. Read genres and channels from DB for the **active profile**
2. Apply `applyGenreOverrides` → hidden genres filtered out, display names overridden
3. Apply `applyChannelOverrides` → hidden channels filtered out
4. Filter by `initialConfig.groups` (if set — whitelist of group titles)
5. Map each channel to `#EXTINF` line via `channelToM3u()`
6. Sort by group title then channel name
7. Persist to `SystemConfig` key `"playlist_cache"` (restored on restart)

### Stream URL format per channel type

Both forms below now carry an opaque `?t={token}` instead of the old `cmd=`/`url=` query params — see [[skill-stream-tokens]]. `channelToM3u()` mints a fresh token per channel per playlist request, scoped to the requesting player's identity (`xtream:{username}`, resolved via `resolveXtreamUser` before the playlist is built — this route is external-player-facing, not JWT-gated).

| Condition | URL format |
|-----------|-----------|
| `cmd` contains portal hostname | `/portal/proxy?t={token}` |
| Otherwise | `/live.m3u8?t={token}&id={id}` (live proxy) |

**No identity → no token**: if `channelToM3u()` is ever called without a resolved `userLabel`, the command is omitted entirely rather than emitting an unauthenticated link — the resulting URL 401s if hit, same fail-closed rule as everywhere else in the token system.

### Logo URL normalization
- Absolute URLs (`http://...`) used as-is
- Relative paths prefixed with `http://{hostname}:{port}/{contextPath}/misc/logos/320/`

### In-memory cache
`liveCache` string — rebuilt on every call to `getM3uV2()` and persisted to DB. Restored from `SystemConfig.playlist_cache` on startup via `loadPlaylistCache()`.

**Caching is skipped entirely when a `userLabel` is resolved** (i.e. on every real request, since the route requires one) — each viewer's links are individually tokenized, so caching one viewer's signed playlist and serving it to another would hand them someone else's tokens. The `liveCache`/`SystemConfig` persistence path only fires for the (effectively unused) unauthenticated case. In practice this route rebuilds the playlist on every request now, not once per change.

---

## VOD M3U (`getVodM3uV2`)

Served at `GET /vod.m3u`.

### Caching strategy (background refresh)
- In-memory `vodCache` string; TTL = **6 hours** (`VOD_CACHE_TTL = 21600000ms`)
- If cache is empty → trigger background refresh, return empty playlist immediately
- If cache is stale → trigger background refresh, return stale cache (avoid blocking)
- Only one refresh runs at a time (`vodRefreshInProgress` guard)
- Persisted to `SystemConfig` key `"vod_cache"` and restored on startup

Check refresh status: `GET /api/refresh/vod/status` → `{ inProgress, status }`.  
Trigger manually: `POST /api/refresh/vod`.  
Invalidate: `invalidateVodCache()` (called when overrides change).

### VOD build pipeline (`buildVodM3u`)

All visible genres are processed in **parallel** via `Promise.all` — large libraries build significantly faster than the old sequential approach.

For each visible genre (after override filtering):

**Virtual categories (`vcat_*` prefix):**
- No portal backing — reads items from `ContentOverride` where `target_category_id` matches
- Fetches source items from `XtreamCache` using `original_category_id`
- Applies `display_name` from override if set

**Regular categories:**
- Paginated: fetches all pages from provider until an empty page (page size < 14 = last page)
- Splits by `SERIES_FLAG`: movies vs series items
- Applies `applyPortalItemOverrides` (handles hide, rename, move-in, move-out)
- Each item → `#EXTINF` line with URL `GET /api/vod/play?t={token}&category=...` — token resource is the provider's own item **id** (not a URL); `/api/vod/play` resolves the real stream URL fresh via `getMovieLink` when the token is redeemed. Same per-viewer-token caveat as the live M3U — the VOD cache below is shared/6h despite this, since rebuilding it walks the whole catalog (see [[skill-stream-tokens]] for the tradeoff this accepts: stale attribution across viewers, not stale/broken links).

---

## EPG XML (`getEPGV2`)

Returns XMLTV XML for Stalker live channels. Used by `GET /epg.xml`.

### Build pipeline
1. Read genres + channels for active profile
2. Filter by `initialConfig.groups`
3. Build `<channel>` entries with display name and logo
4. For each channel: call `serverManager.getProvider().getEPG(channel.id)` and emit `<programme>` entries
5. Timestamp format: `YYYYMMDDHHmmss +0000`

Channel fetch is parallelized via `Promise.all`. XML entities are escaped (`&amp;`, `&lt;`, etc.).

---

## M3U Format (`M3U` class, `src/types/types.ts`)

```
#EXTM3U
#EXTINF:-1 tvg-id="{id}" tvg-name="{name}" tvg-logo="{logo}" group-title="{group}",{name}
{stream_url}
```

Channel names have `,` and ` - ` stripped to avoid M3U parsing issues.

---

## Proxy URL Signing

Live segment URLs (`/player/{token}.ts`) carry an opaque, server-side, randomly-minted token instead of the resource ID — the token *is* the credential now, replacing the old `PROXY_SECRET`-based HMAC signing entirely. See [[skill-stream-tokens]] for the full token/gating system.

---

## Key Files

- `src/utils/getM3uUrls.ts` — `getM3uV2`, `getVodM3uV2`, `getEPGV2`, `buildVodM3u`
- `src/types/types.ts` — `M3U`, `M3ULine` classes
- `src/utils/overrides.ts` — `applyGenreOverrides`, `applyChannelOverrides`, `applyPortalItemOverrides`
- `src/routes/proxy.ts` — `handleProxyStream`
- `src/services/StreamTokens.ts` — token minting used throughout this file, see [[skill-stream-tokens]]