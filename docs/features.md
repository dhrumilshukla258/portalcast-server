# Stalker M3U Server — Full Feature Reference

---

## Table of Contents

1. [Environment Variables](#environment-variables)
2. [Provider Types](#provider-types)
3. [Portal Type Auto-Detection](#portal-type-auto-detection)
4. [Cache Warming](#cache-warming)
5. [VOD Category Versioning](#vod-category-versioning)
6. [Content Manager](#content-manager)
7. [Override System](#override-system)
8. [Jellyfin / .strm Integration](#jellyfin--strm-integration)
9. [EPG Handling](#epg-handling)
10. [Profiles](#profiles)
11. [Live Stream Proxy](#live-stream-proxy)
12. [Reverse Proxy & Public URLs](#reverse-proxy--public-urls)
13. [TMDB Integration](#tmdb-integration)
14. [Authentication](#authentication)
15. [API Reference](#api-reference)

---

## Environment Variables

### Portal (Stalker)

**Neither provider requires environment variables.** Both Stalker and Xtream config (hostname/port/mac/path/stb-type for Stalker; host/username/password for Xtream) are stored per-profile as JSON in `ConfigProfile.config` (`src/models/ConfigProfile.ts`) and set entirely through the browser UI's profile form (`POST`/`PUT /api/profiles`, see [Profiles](#profiles)). Switching or editing the active profile calls `serverManager.reloadConfig()` — no restart.

The `STALKER_*` env vars below only pre-fill the *default* values shown when creating a brand-new profile (`ConfigDefault` in `src/config/server.ts`) — they have no effect on an existing profile's stored config.

| Variable | Default | Description |
|----------|---------|-------------|
| `STALKER_HOST` | — | Portal hostname |
| `STALKER_PORT` | `80` | Portal port |
| `STALKER_HTTPS` | `false` | Use HTTPS for portal connection |
| `STALKER_PATH` | `stalker_portal` | Context path |
| `STALKER_MAC` | `00:1A:79:00:00:00` | MAC address for STB emulation |
| `STALKER_STB` | `MAG254` | STB type |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listen port |
| `NODE_ENV` | — | `production`/`development` etc. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `JWT_SECRET` | — | **Required.** JWT signing key — server refuses to start if unset |
| `ADMIN_EMAIL` | — | **Required for admin login.** Email address mapped to the admin account |
| `ADMIN_PASSWORD` | — | **Required for admin login.** Admin password — returns 503 if unset |
| `PUBLIC_BASE_URL` | — | Hard override for all generated URLs (e.g. `https://iptv.example.com`). If unset, URLs are derived per-request from `X-Forwarded-*` headers or the request host |
| `STREAM_IDLE_TIMEOUT_MS` | `60000` | How long a stream session can go quiet (no request) before the admin "active streams" view drops it — see [[skill-stream-tokens]] |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client ID — enables Google sign-in for users and TV pairing |
| `TLS_CERT_PATH` | — | TLS certificate path (enables HTTPS on the server) |
| `TLS_KEY_PATH` | — | TLS key path |

### Content

| Variable | Default | Description |
|----------|---------|-------------|
| `SERIES_FLAG` | `is_series` | Only matters for **mixed-content portals** — a single VOD endpoint returning both movies and series, split by this boolean-ish field (value `1` = series). Portals with a genuinely separate series endpoint are auto-detected (`portal_series_source` cache row) and don't use this at all — see [Provider Support](#provider-support) |
| `VOD_CATEGORY_VERSIONING` | `false` | Set `true` to append version suffix to category IDs in Xtream responses |
| `STRM_MOVIES_PATH` | — | Directory to write movie `.strm` files for Jellyfin/Emby |
| `STRM_SERIES_PATH` | — | Directory to write series `.strm` files for Jellyfin/Emby |
| `STRM_BASE_URL` | — | Base URL written into `.strm` files (e.g. `http://192.168.1.100:3000`). Xtream provider defaults to the upstream server; Stalker defaults to `http://localhost:PORT` |
| `STRM_XTREAM_USERNAME` | `ADMIN_EMAIL` | Username embedded in `.strm` stream URLs. Defaults to `ADMIN_EMAIL` so STRM files share the same credential as web UI and Xtream API. |
| `STRM_XTREAM_PASSWORD` | `ADMIN_PASSWORD` | Password embedded in `.strm` stream URLs. Defaults to `ADMIN_PASSWORD`. |
| `TMDB_API_READ_TOKEN` | — | TMDB read token for metadata enrichment |
| `OPENSUBTITLES_API_KEY` | — | Enables `/api/v2/subtitles/search` and `/download` (online subtitle search in the player). `searchSubtitles()` (`src/content/opensubtitles.ts`) checks this first and returns `[]` immediately if unset — logs a warning rather than failing loudly, so a missing key looks like "no subtitles found," not an error |

### Networking

| Variable | Default | Description |
|----------|---------|-------------|
| `API_TIMEOUT` | `5000` | HTTP request timeout (ms) |
| `API_RETRIES` | `3` | Retry attempts on failed requests (disabled for streams and aborted requests) |
| `PROVIDER_TIMEOUT` | `120000` | Timeout (ms) for portal upstream requests (Xtream + Stalker) |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_MAX` | `120` | Max requests per window per IP for public stream endpoints |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window size (ms) for rate limiting |

Two independent per-IP buckets, not one shared bucket — `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` apply separately to each:
- **live**: `/live/*`, `/live.m3u8`, `/player/*`
- **vod**: `/movie/*`, `/series/*`, `/api/media/*`, `/api/vod/play`

Split this way (`src/server.ts`'s `onRequest` limiter) so a client hammering one (e.g. an hls.js retry loop with no backoff spamming `/live.m3u8`) exhausts only its own bucket and can't 429 the other content type for that same IP. Returns `429 Too Many Requests` when a bucket's limit is exceeded.

### Circuit Breaker

| Variable | Default | Description |
|----------|---------|-------------|
| `CB_FAILURE_THRESHOLD` | `5` | Consecutive failures before circuit opens |
| `CB_FAILURE_WINDOW_MS` | `60000` | Window in which failures are counted (ms) |
| `CB_COOLDOWN_MS` | `30000` | Time circuit stays open before attempting half-open probe (ms) |

Both `XtreamClient` and `StalkerAPI` use a circuit breaker. Auth errors (401/403) do not count as failures — only network/timeout errors do.

---

## Provider Types

The server supports two backend provider types, switchable per-profile without restart.

### Stalker Portal

Connects to a Stalker Middleware portal using STB emulation (MAC address + token authentication). All portal API calls go through the Stalker `load.php` endpoint. The `stalkerApi` singleton manages token refresh, watchdog keep-alive, and request queuing.

**Configuration:** set via the browser UI's profile form, stored in `ConfigProfile.config`. `STALKER_HOST`, `STALKER_MAC`, etc. only seed the default values a new profile starts with — see [Environment Variables](#portal-stalker).

### Xtream Codes API

Connects to any Xtream Codes-compatible API (`player_api.php`). Credentials (host, port, username, password) are stored in the active `ConfigProfile` in the database and configured via the browser UI.

**VLC User-Agent** is sent on all Xtream requests to maximize compatibility with portal-side access controls.

**Stream URLs** for Xtream use `this.baseUrl` (the portal's own address) and detect the real container extension via `get_vod_info` / `get_series_info` before building the final URL — falling back to `.mp4` if unavailable.

### Switching providers

Switching the active profile reinitializes the provider, stops the Stalker watchdog, clears the in-memory cache, and broadcasts a config-change event via WebSocket — no restart required.

---

## Portal Type Auto-Detection

Two portal layouts are supported and detected automatically on first series category warm:

**Type 1 — Mixed portal**
- Movies and series share the same VOD endpoint
- Items with `{SERIES_FLAG} == 1` are treated as series
- `SERIES_FLAG` defaults to `is_series`; override with the env var for portals using a different field name

**Type 2 — Native series portal**
- Separate `get_series` / `get_series_categories` API for series
- `get_vod_streams` returns only movies
- Separate category lists for each content type
- Detected and stored in cache as `portal_series_source = "native"`

Detection is automatic. The result is cached in `XtreamCache` under `portal_series_source`. To force re-detection, clear the Xtream cache or refresh series groups.

---

## Cache Warming

Content is cached in SQLite (`XtreamCache` table, 24-hour TTL) so the server never makes live portal calls during playback.

### Incremental warm (startup + every 24h)

`warmVodCache()` and `warmSeriesCache()` run in parallel:

1. Fetch portal pages until a known item is encountered
2. Only new items are inserted — no full reload
3. If new content is found, `bumpVodVersion()` is called to signal players
4. Genres are upserted based on actual content found
5. `cleanupGenres()` removes any genre entries with no cached content

`warmSeriesInfoCache()` runs independently after the series warm:
- Iterates every cached series and pre-fetches all seasons/episodes
- 500ms throttle between series to avoid portal hammering
- Stores episodes under `ep_info_{ep_id}` and `ep_cmd_{ep_id}`

### Full catchup scan

`POST /api/v2/catchup-scan` — reconciles local XtreamCache against portal totals per genre:

- **diff > 0** (portal has more): incremental scan from page 1, tracking `balance = new items found`; stops when `balance >= diff`. Deletions detected in scanned pages are also removed.
- **diff < 0** (portal has fewer): scans ALL portal pages; builds a complete portal ID set; removes local items absent from portal; also picks up newly added items.
- **diff = 0**: skip (already in sync).

Use after a long offline period to fill gaps the incremental warm misses (it stops at the first known item). Manually triggering it this way scans the **whole catalog**, no throttle, and — on its own — only reconciles the `XtreamCache` list cache (`vod_streams_*`/`series_list_*`); it never touches `ContentMeta`, the Discover tag tables, or `UserProgress` (see [[skill-content-lifecycle]] for the layer that does). That layer now reuses this same function automatically, scoped down — see below.

### Stale content sweep (automatic, rotating — new)

`sweepStaleContent()` runs automatically on the same 24h interval as the incremental warm (deliberately not also at startup — no need for an extra portal round-trip on every restart) by calling the catchup-scan logic above with three options the manual endpoint doesn't use: `genreIds` (a small rotating slice of 5 categories per run instead of the whole catalog — cursor persisted in `SystemConfig`, so a full pass completes gradually over many days rather than in one burst), `throttleMs` (a pace between categories), and `onRemoved` (prunes `ContentMeta`, its genre/country/theme tags, and any orphaned Continue Watching/`UserProgress` entry for every id the scan confirms gone — not just the list cache). Full detail → [[skill-content-lifecycle]].

### Cache key patterns

| Key | Content |
|-----|---------|
| `vod_streams_{category_id}` | Movie list for a genre |
| `series_list_{category_id}` | Series list for a genre |
| `series_info_{series_id}` | Seasons and episodes |
| `vod_info_{stream_id}` | Movie metadata |
| `vod_cmd_{stream_id}` | Movie playback command |
| `ep_info_{episode_id}` | Episode metadata |
| `ep_cmd_{episode_id}` | Episode playback command |
| `portal_series_source` | `"native"` or `"mixed"` |

---

## VOD Category Versioning

**The problem:** Free IPTV players (TiviMate free, etc.) cache category contents and only refresh when they see a new category ID. After a force-update they won't pick up new movies unless the category ID has changed.

**The trick:** When `VOD_CATEGORY_VERSIONING=true`, a Unix timestamp version is appended to every VOD and series category ID in Xtream responses:

```
category_id: "42"  →  category_id: "42_v1719234567890"
```

When new content arrives or you reorder/move items in the Content Manager, `bumpVodVersion()` writes a new timestamp. The player sees new category IDs on the next force-refresh and re-fetches the stream lists automatically.

**Internally**, `stripVer()` removes the suffix before any cache lookup, so the bare ID is always used server-side.

Version bumps are triggered by:
- New content found during a warm cycle
- Category reorder (genres/reorder endpoint)
- Item moved to a different category (items/reorder endpoint)
- Server startup

**When NOT to use this:** If your player has a premium APK that bypasses Xtream category endpoints entirely, leave `VOD_CATEGORY_VERSIONING` unset.

---

## Content Manager

Access at `http://your-server:3000/contentmanager`. Password protected via `ADMIN_PASSWORD`.

Three tabs: **Live**, **VOD**, **Series**.

### Category operations

| Action | Description |
|--------|-------------|
| Rename | Override the display name (original is preserved in DB) |
| Hide | Exclude from all API responses |
| Reorder | Drag-and-drop or A-Z sort; persists `sort_order` |
| Reset order | Clear custom sort, restore original portal order |
| Create virtual | Add a new user-defined category (VOD/Series only) |
| Delete virtual | Removes the category; items moved into it are restored to their originals |

### Item operations

| Action | Description |
|--------|-------------|
| Rename | Override display name |
| Hide | Exclude from all API responses |
| Move | Reassign to a different category, including virtual ones (VOD/Series only) |
| Reorder | Drag within category; persists `sort_order` |
| Multi-select | Shift+click for range selection; all selected items get the same operation |

All changes are stored in `GenreOverride` and `ContentOverride` tables and applied transparently to every Xtream, M3U, and browse API response — the portal cache is never modified.

---

## Override System

Two database tables power the override layer:

### GenreOverride

| Field | Purpose |
|-------|---------|
| `genre_key` | Composite key: `{type}_{id}` e.g. `movie_42` |
| `display_name` | Renamed title (null = no rename) |
| `hidden` | Exclude from responses |
| `sort_order` | Custom position (null = original order) |
| `virtual` | True for user-created categories |
| `virtual_title` | Name of virtual category |

### ContentOverride

| Field | Purpose |
|-------|---------|
| `item_key` | Composite key: `{type}_{id}` e.g. `movie_12345` |
| `item_type` | `movie`, `series`, or `channel` |
| `display_name` | Renamed title |
| `hidden` | Exclude from responses |
| `target_category_id` | Category to move item into (supports virtual `vcat_*` IDs) |
| `original_category_id` | Source category (saved for restore) |
| `sort_order` | Custom position within category |

### Move semantics

When an item is moved, `target_category_id` is set and `original_category_id` is saved. When fetching a category, items moved away are excluded and items moved in are appended after applying sort order. Deleting a virtual category restores all items that were moved into it to their original categories.

### Virtual categories

Virtual categories have IDs prefixed `vcat_`. The Xtream response normalizes `vcat_*` → `*` before any portal API call, so the portal never sees the virtual ID. Items can be moved into virtual categories freely — they appear under that category in all API responses and are excluded from their original category.

---

## Jellyfin / .strm Integration

Set `STRM_MOVIES_PATH` and/or `STRM_SERIES_PATH` to a directory Jellyfin/Emby can scan. Generation is **manual only** — `POST /api/admin/strm/generate` (also reachable from the Admin Dashboard's Stats tab). It is not triggered by cache warming or on any schedule; re-run it yourself when content changes. Files are only rewritten when the URL/name actually changed, and removed/renamed content is pruned on each run — see [[skill-content-manager]] for the full hardening detail.

STRM generation reads from `XtreamCache` (global) and genres from all profiles, so it works even when the **active provider is Stalker** — as long as XtreamCache was previously populated by an Xtream profile. When the active provider is not Xtream, `STRM_XTREAM_USERNAME` and `STRM_XTREAM_PASSWORD` **must** be set explicitly, otherwise stream URLs will contain Stalker credentials (a `logger.warn` is emitted if missing).

### Folder layout

**Movies:**
```
<STRM_MOVIES_PATH>/
  Movie Title (2023)/
    Movie Title (2023).strm
    Movie Title (2023) [4K].strm
    Movie Title (2023) [Hindi Dubbed].strm
```

**Series:**
```
<STRM_SERIES_PATH>/
  Show Name (2021)/
    Season 01/
      Show Name (2021) S01E01 - Episode Title.strm
```

### Duplicate merging

Portals commonly list the same movie multiple times with variant tags (language, quality, source). The server automatically:

1. Groups by canonical title (stripped of variant tags)
2. Picks the cleanest name as the primary folder
3. Renames duplicates as `Title [Tag].strm` inside the same folder
4. Removes now-empty secondary folders on regeneration

Variant tag patterns detected:
- **Quality:** 4K, UHD, FHD, HD, SD, 720p, 1080p, 2160p
- **Audio:** Dual Audio, Dubbed, Multi, TriAudio
- **Language:** Hindi, Tamil, Telugu, Malayalam, Kannada, Bengali, and more
- **Format:** BluRay, WEBRip, WEB-DL, DVDRip, HDRip, HDCAM, CAM, TS

Trigger manual regeneration: `POST /api/admin/strm/generate` or via the Content Manager UI.

---

## EPG Handling

EPG data is fetched from the portal, cached in SQLite (`EpgCache` table, compressed with gzip), and served as XMLTV at `/epg.xml`.

### Fetch strategy

- **On startup:** fetch immediately if cache is missing or stale (>12 hours)
- **Background job:** checks every 30 minutes; only fetches if stale AND server has been idle for >2 minutes
- **On-demand:** `POST /api/v2/refresh-epg`

### Concurrency

Channels are fetched 5 at a time with a yield between batches to avoid memory spikes on large channel lists.

### Storage

EPG XML is gzip-compressed before writing to SQLite, with transparent decompression on read and a fallback for legacy uncompressed entries.

### Title decoding

Xtream portals Base64-encode EPG titles. The server decodes them automatically — with fallback handling for both standard and URL-safe Base64 variants and non-Base64 plain-text titles.

---

## Profiles

Multiple portal configurations can be stored and switched without restarting the server.

- Each profile has its own channels, genres, and EPG cache
- Content overrides (`GenreOverride`, `ContentOverride`) are **global** — shared across all profiles
- Only one profile can be active at a time
- Switching profiles stops the current provider, clears in-memory cache, reinitializes the provider with new credentials, and broadcasts a config-change event via WebSocket
- Deleting a profile cascades to its channels, genres, and EPG cache

**Profile API:** `GET/POST/PUT/DELETE /api/profiles` and `/api/profiles/{id}/activate`

---

## Live Stream Proxy

### Client-aware mode selection (`/live.m3u8`)

The web UI requests live streams as `/live.m3u8?t={token}&id=...&proxy=1` — `t` is an opaque stream token minted server-side (see [[skill-stream-tokens]]), never a raw `cmd`. The server picks the delivery mode per client:

| Client | Behavior |
|--------|----------|
| Browser (`proxy=1`) | **Always proxied** — playlists rewritten to same-origin tokenized segment URLs. Browsers cannot follow redirects to the upstream portal (CORS / mixed content), so `proxy=1` overrides the profile's proxy setting |
| Smart TV (`Tizen`/`SMART-TV`/`WebOS` user-agent) | **Direct 302 redirect** to the resolved CDN URL — TV webviews are not CORS-bound and decode natively, so no server bandwidth is used |
| `proxy=0` | Forces a direct redirect regardless of config |
| No `proxy` param (IPTV players) | Follows the active profile's `proxy` setting |

### Xtream live streams (`LiveStreamService`)

Two modes controlled per-request via `proxy=0` query param (default is proxy-on based on server config):

**Proxy mode (default):**
- `liveStreamService` fetches the master HLS playlist from the portal, rewrites segment URLs to tokenized `/player/{token}.ts` paths, and caches the segment map
- Segments are served at `GET /player/{token}.ts` (`liveStreamService.getSegmentByResourceId`) — the token resolves to the real `cmd<_>seq` resourceId server-side, nothing about it is derivable from the URL itself
- VLC User-Agent is sent on all upstream HLS fetches
- Cache miss on a segment triggers a playlist refresh using the stored subpath

**Non-proxy mode:**
- `serverManager.getProvider().getChannelLink(cmd)` resolves the real CDN URL
- Client receives a `302` redirect directly to the stream

### Stalker live streams (HLS caching)

1. **Master playlist** — resolved from portal command via `cmdPlayerV2` and cached for 30 seconds
2. **Segment map** — `#EXT-X-MEDIA-SEQUENCE` number → relative URL, stored per stream
3. Segments served at `GET /player/{token}.ts` — an opaque per-segment token replaces the older HMAC-signed resource ID scheme (see [[skill-stream-tokens]])
4. On 301/302/403, server auto-refreshes the master URL and updates the cached base URL
5. Concurrent requests for the same stream share a single upstream fetch (pending-promise deduplication)

### Catchup

`GET /live.m3u8?t={token}&start_time=...&end_time=...` passes timestamps to `cmdPlayerV2`, which forwards them to the portal's catchup endpoint. The token resolves to `cmd` server-side, same as any other `/live.m3u8` request.

---

## Reverse Proxy & Public URLs

The server can be reached simultaneously via LAN `ip:port` and an HTTPS domain behind a reverse proxy (Caddy, nginx, Traefik). Every generated absolute URL is resolved **per request** by `src/infra/publicUrl.ts` with this priority:

1. `PUBLIC_BASE_URL` env var — hard override, pins one canonical address
2. `X-Forwarded-Proto` / `X-Forwarded-Host` headers set by the reverse proxy
3. The `Host` header of the incoming request

When the request arrives with no explicit port through an HTTPS proxy, the Xtream handshake reports port `443`/`https` (not the internal listen port), so players configured with the bare domain build correct stream URLs.

**Affected URLs:** Xtream `server_info` (player handshake), M3U playlist entries (`/playlist.m3u`, `/vod/playlist.m3u`), and TV device-pairing verification links.

**Proxy configuration:**
- **Caddy** — a plain `reverse_proxy` block is enough (it preserves `Host` and sets `X-Forwarded-Proto` by default)
- **nginx** — add `proxy_set_header Host $host;` and `proxy_set_header X-Forwarded-Proto $scheme;`

**PWA note:** the web app's service worker (active only on HTTPS origins) serves the SPA shell for page navigations. Server-rendered paths (`/contentmanager`, playlists, EPG, stream endpoints) are on its denylist so they always reach the server. If you add new server-rendered pages, add them to the denylist in `public/sw.js`.

---

## TMDB Integration

Set `TMDB_API_READ_TOKEN` to enrich VOD and series metadata with posters and backdrops.

The server strips quality/format tags from titles before searching TMDB:
```
Avatar 4K BluRay  →  search "Avatar"
```

Returns `poster`, `backdrop`, and `overview`. Enriched metadata is merged into Xtream `get_vod_info` and `get_series_info` responses. If TMDB is unavailable or the token is not set, the fields are silently omitted — nothing breaks.

---

## Authentication

### Admin auth

Two ways in:

- **Normal login** — `POST /api/auth/login` with `ADMIN_EMAIL` + `ADMIN_PASSWORD` (auto-creates/promotes the admin user record)
- **Admin login** — `POST /api/auth/admin` with `{ password }` matching `ADMIN_PASSWORD` (used by the Content Manager UI)

**Bootstrap mode:** if neither `ADMIN_EMAIL` nor `ADMIN_EMAILS` is set, *any* email + `ADMIN_PASSWORD` logs in as admin, and a warning is printed at startup. Set `ADMIN_EMAIL` to lock this down.

### User auth

Email/password registration and login via `/api/auth/signup` and `/api/auth/login`. New users start as `pending` and must be approved by an admin before they can log in. Admins can approve, suspend, or promote users via the user management API.

### Google OAuth

`POST /api/auth/google` with a Google ID token. If the email matches `ADMIN_EMAIL` or `ADMIN_EMAILS` (comma-separated), the account is auto-promoted to admin. Otherwise it is created as a pending user awaiting approval. Requires `GOOGLE_CLIENT_ID` to be set.

### TV / device code pairing

For Samsung TV apps and other headless clients that can't do browser-based OAuth:

1. Device calls `POST /api/auth/device/code` — receives a short user code (e.g. `ABC-DEF`), a device code, and a verification URL (reverse-proxy aware)
2. The TV displays the user code
3. A logged-in user enters the code in the web UI (`POST /api/auth/device/authorize`)
4. Device polls `POST /api/auth/device/poll` with its device code — receives access + refresh JWTs once authorized (TV refresh tokens last 6 months)

Codes expire after 5 minutes. The device can poll until expiry. Expired/unclaimed codes are purged by the daily DB cleanup job, not by this flow itself — see [[skill-database]].

The web UI's `/verify` page (step 3) auto-redirects the user back into the app a couple seconds after successful authorization rather than leaving them on a static confirmation screen — relevant now that a logged-in user can reach it directly via a header menu entry ("Authorize a Device"), not only via a logged-out phone scanning a QR code with nothing else to do. Browser-history handling around login redirects was also hardened (`replace`, not `push`) to prevent a loop where pressing Back after logging in kept bouncing back to the login screen instead of reaching the page visited beforehand. Full detail → [[skill-auth-system]].

### JWT scope & role gating

All `/api/` and `/v2/` endpoints require `Authorization: Bearer <token>` unless explicitly exempted:
- Stream proxies (`/api/proxy`, `/api/vod/`, `/api/v2/download`)
- Auth endpoints (`/api/auth/`), image proxy (`/api/images/`)
- Player paths (`/live.m3u8`, `/player/`, `/live/`, `/movie/`, `/series/`, `/player_api.php`, `/xmltv.php`)
- Portal proxy (`/portal/proxy`)

On top of the JWT requirement, a role check applies:
- **Admin-only paths** (any method): `/api/admin/`, `/api/profiles`, `/api/config`, `/api/upload`, refresh/debug endpoints, `/api/v2/get-token`
- **All mutations** (POST/PUT/DELETE/PATCH) require the admin role, except user-owned data (`/api/user/*`) and device authorization

### Xtream player credentials

Xtream player paths use URL-embedded credentials (`{username}/{password}`), validated on every request against:
1. Any **active user** in the `Users` table (email + password — the same account as web login)
2. The **admin env credentials** (`ADMIN_EMAIL` + `ADMIN_PASSWORD`; email check skipped in bootstrap mode)

There is no shared playlist password — the legacy profile `username`/`password` fallback was removed because its defaults were guessable.

### Stream token substitution

When a player authenticates via `GET /player_api.php`, the `user_info.password` in the JSON response is a **30-day JWT stream token** (`{ sub: userId, scope: "stream" }`) instead of the real password. IPTV players cache this value and reuse it in all subsequent stream URLs — the real password never appears in `/live/{u}/{token}/...` paths.

`resolveXtreamUser()` validates either a real password or a valid stream token. Env-var-only admin (no DB record) keeps the real password as fallback.

---

## API Reference

### Xtream Codes

| Endpoint | Actions |
|----------|---------|
| `GET /player_api.php` | `get_live_categories`, `get_live_streams`, `get_vod_categories`, `get_vod_streams`, `get_vod_info`, `get_series_categories`, `get_series`, `get_series_info`, `get_short_epg` |
| `GET /live/{user}/{pass}/{id}.m3u8` | Live stream (HLS proxy or redirect) |
| `GET /live/{user}/{pass}/{id}.ts` | Live stream (TS segment proxy or redirect) |
| `GET /movie/{user}/{pass}/{id}.{ext}` | VOD stream (proxy) |
| `GET /series/{user}/{pass}/{id}.{ext}` | Episode stream (proxy) |
| `GET /xmltv.php` | EPG (XMLTV) |
| `GET /{user}/{pass}/{id}` | Legacy redirect (for players omitting `/live/`) |

### Browse (internal UI / custom players)

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/groups` | Live channel groups |
| `GET /api/v2/channels` | Live channels |
| `GET /api/v2/movie-groups` | VOD categories |
| `GET /api/v2/movies` | Movies (paginated) |
| `GET /api/v2/series-groups` | Series categories |
| `GET /api/v2/series` | Series (paginated) |
| `GET /api/v2/channel-link` | Resolve live stream URL |
| `GET /api/v2/movie-link` | Resolve VOD / episode URL |
| `GET /api/v2/epg` | EPG data |
| `GET /api/v2/expiry` | Portal subscription expiry |

### Sync

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/refresh-groups` | Sync live groups |
| `GET /api/v2/refresh-channels` | Sync live channels |
| `GET /api/v2/refresh-movie-groups` | Sync VOD categories + trigger warm |
| `GET /api/v2/refresh-series-groups` | Sync series categories + auto-detect portal type |
| `POST /api/v2/refresh-epg` | Refresh EPG |
| `POST /api/refresh/vod` | Refresh VOD playlist |
| `GET /api/refresh/vod/status` | VOD refresh status |

### Cache

| Endpoint | Description |
|----------|-------------|
| `POST /api/v2/warm-xtream-vod` | Warm VOD cache (incremental) |
| `POST /api/v2/warm-xtream-series` | Warm series cache (incremental) |
| `POST /api/v2/catchup-scan` | Full gap-fill scan |
| `POST /api/v2/cleanup-genres` | Remove empty genre DB entries |
| `DELETE /api/v2/clear-xtream-cache` | Wipe Xtream cache (triggers re-detection of portal type) |
| `POST /api/clear-cache` | Clear active provider in-memory cache |

### Config & Auth

| Endpoint | Description |
|----------|-------------|
| `GET /api/config` | Get server config |
| `POST /api/config` | Update server config |
| `POST /api/auth/admin` | Admin login — `{ password }` → JWT (Content Manager) |
| `POST /api/auth/signup` | Register new user — starts as pending |
| `POST /api/auth/login` | Email/password login → JWT |
| `POST /api/auth/google` | Google OAuth login → JWT |
| `POST /api/auth/refresh` | Refresh JWT |
| `POST /api/auth/device/code` | Request a TV pairing code |
| `POST /api/auth/device/poll` | Poll for JWT after pairing (device) |
| `POST /api/auth/device/authorize` | Authorize a pairing code (web UI) |
| `GET /api/v2/get-token` | Get API token (Stalker only) |
| `POST /api/v2/clear-tokens` | Revoke all tokens (Stalker only) |

### User Management (admin only)

| Endpoint | Description |
|----------|-------------|
| `GET /api/admin/users` | List all users |
| `POST /api/admin/users` | Create user |
| `GET /api/admin/users/{id}` | Get user |
| `PUT /api/admin/users/{id}` | Update user (approve / suspend / role) |
| `DELETE /api/admin/users/{id}` | Delete user |

### User Profile

| Endpoint | Description |
|----------|-------------|
| `GET /api/user/profile` | Get own profile |
| `PUT /api/user/preferences` | Update preferences. Pushes a `preferences_changed` Socket.IO event to the user's other logged-in sessions — see below |
| `GET /api/user/progress` | Get watch progress |
| `POST /api/user/progress` | Save watch progress |
| `DELETE /api/user/progress/{mediaId}` | Remove progress entry |
| `POST /api/user/clear-history` | Clear all watch history. Also pushes `preferences_changed` |

#### Real-time preference sync (Socket.IO)

Preferences (favorites, recent channels, last-selected category/TV group/channel, etc. — see [[skill-user-system]]) sync across a user's own devices in two ways: a pull on login and on tab focus/`visibilitychange`, and — since this session — an instant push. The client joins room `user:{userId}` by emitting `join_user_room` with its JWT once connected; the server verifies the token and joins that socket to the room. Every successful `PUT /api/user/preferences` or `POST /api/user/clear-history` then emits `preferences_changed` to that room only (never broadcast-to-all), and any other open session for that account calls `refreshProfile()` in response. Full detail → [[skill-user-system]].

### Profiles

| Endpoint | Description |
|----------|-------------|
| `GET /api/profiles` | List profiles |
| `POST /api/profiles` | Create profile |
| `GET /api/profiles/{id}` | Get profile |
| `PUT /api/profiles/{id}` | Update profile |
| `DELETE /api/profiles/{id}` | Delete profile |
| `POST /api/profiles/{id}/activate` | Switch active profile |
| `POST /api/profiles/{id}/enable` | Enable profile |
| `POST /api/profiles/{id}/disable` | Disable profile |

### Content Manager

| Endpoint | Description |
|----------|-------------|
| `GET /contentmanager` | Browser UI |
| `GET /api/admin/genres?type=` | List categories with override state |
| `POST /api/admin/genres/{type}` | Create virtual category |
| `PUT /api/admin/genres/{type}/{id}` | Update category (rename / hide / sort) |
| `PUT /api/admin/genres/{type}/reorder` | Bulk-set category sort order |
| `DELETE /api/admin/genres/{type}/{id}` | Remove category override |
| `DELETE /api/admin/genres/{type}/order` | Clear all custom sort order |
| `GET /api/admin/items?type=&category_id=` | List items with override state |
| `PUT /api/admin/items/{type}/{id}` | Update item (rename / hide / move) |
| `PUT /api/admin/items/{type}/{category_id}/reorder` | Bulk-set item sort order |
| `DELETE /api/admin/items/{type}/{id}` | Remove item override |
| `POST /api/admin/strm/generate` | Trigger `.strm` generation |

### Content Enrichment (admin only)

| Endpoint | Description |
|----------|-------------|
| `POST /api/admin/content-meta/enrich` | Trigger TMDB enrichment for any un-enriched titles. Pass `includeBackdropBackfill: true` to also run the backdrop-image retry pass (`backfillBackdrops()`) — this is the **only** thing that ever advances it; the automatic startup/24h cycle never includes it. See [[skill-content-lifecycle]] |
| `GET /api/admin/content-meta/status` | Enrichment progress/status |
| `POST /api/v2/catchup-scan` | Manual full-catalog reconciliation of the `XtreamCache` list cache against the portal's own totals (adds + removes ids), no throttle. Only touches the list cache, not `ContentMeta`/`UserProgress` — the same underlying `catchupScan()` function is reused automatically in a scoped/throttled form by the daily stale-content sweep, see [[skill-content-lifecycle]] |

### Debug

| Endpoint | Description |
|----------|-------------|
| `POST /api/v2/debug/fix-live-icons` | Rewrite legacy cached channel logo URLs to the proxied `/api/images` format (in-place, no deletion) |
| `GET /api/v2/debug/epg?id=` | Raw EPG for a channel |
| `GET /api/v2/debug/vod-item?id=` | Raw portal item |
| `GET /api/v2/debug/episode-fetch?seriesId=&seasonId=` | Episode fetch diagnostics |
