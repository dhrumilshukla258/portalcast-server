# Profiles & EPG — Skill Reference

Covers multi-profile support and EPG (Electronic Program Guide) handling.

Related: [[skill-stalker-provider]], [[skill-xtream-provider]], [[skill-database]]

---

## Profiles

Multiple portal configurations stored in `ConfigProfile`. Only one is active at a time.

### What's profile-scoped
- `Channel` and `Genre` DB rows — each row has a `profileId` foreign key
- `EpgCache` — per-profile EPG data
- `UserProgress` — progress is tied to the active profile at time of update

### What's global (not profile-scoped)
- `GenreOverride` and `ContentOverride` — content manager changes apply to all profiles
- `XtreamCache` — shared across profiles (keyed by category/stream ID, not profile)
- `User` and auth data

### Profile switching
1. `POST /api/profiles/{id}/activate`
2. Stops watchdog on current `StalkerAPI` instance
3. Clears in-memory `NodeCache` on current provider
4. Reinitializes `serverManager` provider with new profile credentials
5. Broadcasts `config-change` event via WebSocket — all connected clients re-initialize
6. No server restart needed

### Profile API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/profiles` | List all profiles |
| `POST` | `/api/profiles` | Create profile |
| `GET` | `/api/profiles/{id}` | Get profile |
| `PUT` | `/api/profiles/{id}` | Update profile |
| `DELETE` | `/api/profiles/{id}` | Delete (cascades to channels, genres, EPG) |
| `POST` | `/api/profiles/{id}/activate` | Switch active profile |
| `POST` | `/api/profiles/{id}/enable` | Enable profile |
| `POST` | `/api/profiles/{id}/disable` | Disable profile |

---

## EPG Handling

EPG data for Stalker portals is fetched per-channel, compressed with gzip, and stored in the `EpgCache` table (SQLite). Served via `GET /api/v2/epg` (whole guide) and `GET /api/v2/epg/window?hours=6` (what both clients should use).

### Serving: snapshot + window (`src/content/epgServe.ts`)
- `getEpgSnapshot()` is the single read path. Per request it runs two small queries (active profile, newest `EpgCache` row's `id`/`timestamp` — never the data column) and returns the in-memory snapshot for that row, rebuilding it only when the row changed (null when missing or > 12 h old, the same rule `getEpgCache()` applies). Builds are shared by concurrent callers.
- A snapshot holds `full` (the whole `/api/v2/epg` body, gzipped once — the route just sends the buffer, gunzipping only for a client without `Accept-Encoding: gzip`) and a columnar store of programmes that have not ended: one `Buffer` with each channel's programme JSON comma-joined in start order, `Uint32Array`s for start, stop, prefix-max stop and byte ranges. Prefix-max stop is monotone even with overlapping programmes, so "first programme still running at t" is a binary search; a window is O(C log P + K) and a run of programmes is one zero-copy `subarray`.
- Windows are hour-aligned (`[hourStart, hourStart + (hours+1) h)`) so one body serves the whole hour; it is built + gzipped once per (hours, hour) and the 6 h one is prebuilt with the snapshot and at each hour boundary. Weak ETag = hash of (row, hours, hour[, ids]); `If-None-Match` → 304. `ids=` windows are built per request (small) and left to hapi to compress.
- Primed by `fetchAndCacheEpg()` after it writes, and at startup (server.ts uses `getEpgSnapshot()` for its "missing or stale?" check; so does `BackgroundJobService`'s 30-min check — neither parses the whole guide any more).
- `getEpgCache()` (full parse into objects) still exists for code that needs the objects; avoid it on request paths.
- Memory: ~the JSON size of not-yet-ended programmes (off-heap) + 20 bytes per programme + the full gzip (~7 MB on the owner's portal). `ETag` is in hapi's CORS `additionalExposedHeaders` so the cross-origin Tizen build can revalidate.

### Fetch strategy
- **Startup:** fetch immediately if cache is missing or stale (> 12 hours old)
- **Background job:** checks every 30 minutes; only fetches if stale AND server idle > 2 minutes
- **On-demand:** `POST /api/v2/refresh-epg`

### Storage
EPG XML is gzip-compressed before writing to SQLite (`EpgCache.data`). Transparent decompression on read. Legacy uncompressed entries are handled via fallback.

`writeEpgCache()` in `src/infra/storage.ts` always destroys the existing row before inserting — including the `profileId: null` case. This prevents unbounded accumulation on repeated EPG refreshes when no profile is active.

### Daily cleanup
A job in `server.ts` (runs on startup and every 24h) deletes `epg_cache` rows with `updatedAt` older than 7 days:
```ts
EpgCache.destroy({ where: { updatedAt: { [Op.lt]: cutoff } } })
```

### Concurrency
Channels are handed over 5 at a time with a yield and a 500 ms pause between batches (`EPG_FETCH_BATCH_DELAY_MS`, used as 0 by the benchmark harness in `scripts/bench`). The fetch runs inside `inBackground()` (`services/portalPace.ts`), so the portal actually sees one request at a time with `portalBackgroundGapMs` (default 1 s, `PORTAL_BACKGROUND_GAP_MS`) between them. A 429 pauses the queue (Retry-After, else 1 min doubling to 30 min), widens the gap and sends the request again (6 tries); the gap narrows again while the portal answers. A channel still refused keeps its previous guide instead of being stored empty. The catalog warm and catch-up scan use the same queue; play links and sign-in never queue, and a 429 does not count against the circuit breaker. On a big portal the first guide takes hours (logged every 500 channels); that is intended.

### Xtream EPG
For Xtream providers, `XtreamClient.getEPG()` uses the portal's `get_short_epg` action (limit: 24 entries per channel). EPG titles are Base64-decoded automatically. It bypasses the client's 6 h request cache (`makeRequest(..., { cache: false })`): the result goes straight into `EpgCache`, and caching 10k parsed responses only held memory.

### Title decoding (Xtream)
Xtream portals Base64-encode EPG titles. `decodeBase64Safe` in `xtream-client.ts` handles:
- Standard Base64
- URL-safe Base64
- Plain-text fallback (non-Base64 strings returned as-is)

### Debug endpoint
`GET /api/v2/debug/epg?id={channelId}` — returns raw EPG data for a channel. Useful for diagnosing missing or malformed EPG entries.

---

## Sync Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/refresh-groups` | Sync live groups |
| `GET /api/v2/refresh-channels` | Sync live channels |
| `GET /api/v2/refresh-movie-groups` | Sync VOD categories + trigger cache warm |
| `GET /api/v2/refresh-series-groups` | Sync series categories + auto-detect portal type |
| `POST /api/v2/refresh-epg` | Refresh EPG |
| `GET /api/v2/epg/window?hours=6&ids=` | Programmes overlapping the next `hours` (1–24), ETag/304 |

---

## WebSocket Events

`SocketService` emits events to all connected browser clients:

| Event | Trigger |
|-------|---------|
| `config-change` | Profile switched |
| `cache-warming` | Cache warm started |
| `cache-warmed` | Cache warm completed |

Connect at `ws://server:3000/` — the frontend uses this to auto-reload when the active profile changes.

---

## Key Files

- `src/routes/account/profiles.ts` — Profile CRUD API
- `src/models/ConfigProfile.ts` — Profile Sequelize model
- `src/models/EpgCache.ts` — EPG cache model
- `src/content/epg.ts` — EPG fetch and cache logic
- `src/content/epgServe.ts` — serving snapshot, `/api/v2/epg/window` windows, ETags
- `src/services/SocketService.ts` — WebSocket event broadcasting
- `src/serverManager.ts` — Provider lifecycle management