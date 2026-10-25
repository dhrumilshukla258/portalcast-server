# Profiles & EPG — Skill Reference

Covers multi-profile support and EPG (Electronic Program Guide) handling.

Related: [[skill-stalker-provider]], [[skill-xtream-provider]], [[skill-database]]

---

## Profiles

Multiple portal configurations stored in `ConfigProfile`. Only one is active at a time.

### Each profile's ids in their own range (2026-10-25)
Two portals both have a category 12 or a movie 5001, and most stores are keyed by those numbers
(category lists `vod_streams_<id>`/`series_list_<id>`, `content_meta` `movie_<id>`, tags,
`episode_index`, TMDB matches, content manager edits, the catalog snapshot). So that two or three
profiles never share them, every profile but the first sees its portal's ids moved:

- `config/profileSlots.ts`: `system_config.profile_id_slots` = `{ profileId: slot }`. The first
  profile to be active takes slot 0 (the portal's own ids: a one-profile server and the data
  every server already has never change); each other profile takes the next slot the first time
  it is activated (`switchProfile` asks before switching, so a profile that cannot get one is not
  made active). Slots are never given twice; 32 in all. When a profile takes a slot other than 0,
  its `Channel`, `Genre`, `EpgCache`, `ContentCache` rows and `epg_empty_<id>` are dropped (they
  held the portal's ids) and fetched again, as an edited profile's are.
- `providers/profileIds.ts`: `scopeProvider(provider, slot)` (applied in `serverManager.initProvider`)
  moves `id`, `category_id`, `tv_genre_id` of every answer to `slot * 2^48 + id` and moves
  `category`, `movieId`, `seasonId`, `episodeId`, link `id`/`series` and the guide's channel id back.
  Only plain numbers move ("*", 0, `12345:2` pass as they are); an id outside the profile's range
  goes in as it is. Everything else (tokens, `cache`, Stalker helpers used by downloads) is the
  provider's own. 2^48 holds every portal id (M3U ids are 48-bit); ids stay safe integers, which
  both apps (the TV app reads ids as text) and SQLite keep exactly.
- `stalkerApi.setActiveChannel` (live.ts) is the one direct call with an id; it gets `portalId()`.
- Values about the portal itself rather than its ids use `profileKey(key)` (`key@<slot>`, as is
  in slot 0): `portal_series_source` (series as their own section, or inside VOD).
- After a switch the catalog snapshot is rebuilt (`rebuildCatalogSoon`), as it holds the active
  profile's categories.

### What's profile-scoped
- Everything keyed by portal ids, through the ranges above
- `Channel` and `Genre` DB rows — each row has a `profileId` foreign key
- `EpgCache` — per-profile EPG data
- `UserProgress` — progress is tied to the active profile at time of update

### What's global (not profile-scoped)
- `User` and auth data, settings, subtitle accounts
- TMDB data keyed by TMDB ids (people, credits by `movie:<tmdbId>`) and channel logos by channel
  name: the same for every portal

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
Channels are handed over 5 at a time with a yield and a 500 ms pause between batches (`EPG_FETCH_BATCH_DELAY_MS`, used as 0 by the benchmark harness in `scripts/bench`). The fetch runs inside `inBackground()` (`services/portalPace.ts`), so the portal actually sees one request at a time with `portalBackgroundGapMs` (default 1 s, `PORTAL_BACKGROUND_GAP_MS`) between them. A 429 pauses the queue (Retry-After, else 1 min doubling to 30 min), widens the gap and sends the request again (6 tries); the gap narrows again while the portal answers. Channels refused anyway (a 429 that outlasted the tries, a failed sign-in) are asked once more after the rest; one still refused keeps its running and upcoming programmes, read back from the served snapshot with `programmesOf()` (never the whole stored guide: loading it held a second copy of the guide, about 500 MB, for the hours the fetch takes). The catalog warm and catch-up scan use the same queue; play links and sign-in never queue, and a 429 does not count against the circuit breaker. On a big portal the first guide takes hours (logged every 500 channels); that is intended.

Channels without a guide: many have none at all (8,138 of 10,171 on one large portal). A channel whose answer was empty at two refreshes in a row is asked again only after `epgEmptyRecheckHours` (default 72, `EPG_EMPTY_RECHECK_HOURS`) and keeps its empty list meanwhile, so the stored guide is the same; from the third refresh that portal sees about 2,000 requests instead of 10,000. Only real answers count (a refused or failed request changes nothing); a channel that gets a guide is picked up at its next ask, a new channel is always asked, and channels no longer listed are forgotten. State per profile in `system_config` (`epg_empty_<profileId>`: channel id -> [empty answers in a row, last asked]). `POST /api/v2/refresh-epg` (Admin's Refresh guide) asks every channel; `0` turns the skipping off. Checked on a copy's 10,171 channels with a stand-in portal: 10,171 / 10,171 / 2,033 requests, the guide identical each time.

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