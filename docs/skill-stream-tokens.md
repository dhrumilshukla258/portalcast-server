# Stream Tokens & Proxy Gating — Skill Reference

Covers the opaque-token system that gates and tracks every stream URL (`/api/proxy`, `/api/proxy/stream`, `/portal/proxy`, `/live.m3u8`, `/player/{token}`, `/live-hls/*`, `/api/vod/play`) and the live "who's watching what" admin view built on top of it. This replaced an earlier base64 `url=`/`cmd=` query-param scheme and a separate HMAC uid-signing scheme — both are gone now.

Related: [[skill-stalker-provider]], [[skill-xtream-provider]], [[skill-content-manager]], [[skill-subtitles]]

---

## Why this exists

Before this system, stream URLs embedded the real upstream address directly — either in plaintext (`?cmd=...`) or base64-encoded (`?url=...`, trivially reversible by anyone who copied the link). That meant:
- Anyone who copied a "play" link could extract the real portal/CDN URL (for Xtream, sometimes including the admin's real upstream credentials in plaintext).
- Nothing prevented an unauthenticated request from streaming through the server for free — `url=` wasn't signed, just encoded.
- There was no way to know which user was watching what.

The fix: every client-facing stream URL now carries a random opaque token (`?t=<32-hex-chars>`). The token maps, **server-side only**, to the real resource *and* the requester's identity. The client can copy/inspect the URL all they want — there's nothing to extract.

---

## Core primitive (`src/services/StreamTokens.ts`)

```ts
mintStreamToken(resource: string, userLabel: string, referer?: string, meta?: StreamTokenMeta): string
resolveStreamToken(token: string | undefined | null): StreamTokenEntry | null
streamTokenFromRequest(request): StreamTokenEntry | null   // reads `t` off request.query
proxyUrlFor(rawUrl: string, userLabel: string, meta?: StreamTokenMeta): string  // → "/api/proxy?t=...&m3u8=1" if rawUrl looks like HLS
```

- In-memory `Map<token, StreamTokenEntry>`, 6-hour idle TTL (long enough for a movie/live session), swept every 10 minutes.
- `StreamTokenEntry = { resource, referer?, userLabel, kind?, label?, category?, createdAt, lastSeen }`.
- `resolveStreamToken` refreshes `lastSeen` on every successful lookup (sliding expiry).
- **`meta` object construction order matters**: `mintStreamToken` builds `{ ...meta, resource, referer, userLabel, createdAt, lastSeen }` — explicit params are spread *after* `meta` so they always win, specifically so a caller accidentally passing a whole `StreamTokenEntry` (which has its own `resource` field) as `meta` can never silently clobber the new token's real resource. This bit a real bug once (see "Lessons" below) — don't reorder this.

### `&m3u8=1` tag

The frontend picks its player type (`application/x-mpegurl` vs `video/mp4`) by checking whether the stream URL string *contains* `"m3u8"`. That worked when raw URLs were visible; now that they're hidden behind a token, `proxyUrlFor` appends `&m3u8=1` when the underlying resource looks like an HLS playlist, as the only remaining signal.

---

## Identity resolution (`userLabel`)

- **Web UI**: JWT via `authCheck(request)` → `payload.email || "user:" + payload.userId`. See `streamUserLabel()` in `src/routes/stalkerV2/`.
- **Xtream players** (TiviMate etc.): already-verified username from `resolveXtreamUser(username, password)` → label is `xtream:${username}`.
- **Legacy plain-M3U export** (`/playlist.m3u`, `/vod/playlist.m3u` in `src/routes/playlist.ts`): same `xtream:${username}` label, since these routes already validate credentials via `resolveXtreamUser` before generating the playlist.

### Fail-closed rule

Any handler that resolves a real upstream URL (movie-link, channel-link) **must** refuse to return it if `userLabel` can't be resolved — never silently fall through and return the raw `movieLink`/`channelLink` object unchanged. See `/api/v2/movie-link` and `/api/v2/channel-link` in `src/routes/stalkerV2/`:

```ts
if (!userLabel) {
  logger.error("[movie-link] No resolvable identity ... refusing to return raw URL");
  return h.response({ error: "Unauthorized" }).code(401);
}
```

---

## Where tokens get minted (producers)

| Producer | File | Resource tokenized | Content kind |
|----------|------|---------------------|--------------|
| `mapChannel()` | `stalkerV2.ts` | `channel.cmd` (real upstream cmd, both provider types) | `live` |
| `/api/v2/movie-link` | `stalkerV2.ts` | `movieLink.js.cmd` from `getMovieLink`/`getSeriesLink` | `movie` / `series` |
| `/api/v2/channel-link` | `stalkerV2.ts` | `channelLink.js.cmd` | `live` |
| Xtream `/live/{u}/{p}/{id}.m3u8`/`.ts` | `xtream.ts` | `channel.cmd` | `live` |
| Xtream `/movie/{u}/{p}/{id}.{ext}`, `/series/{u}/{p}/{id}.{ext}` (stalker-backed) | `xtream.ts` (`handleStalkerVodStream`/`handleStalkerSeriesStream`) | resolved item URL | `movie` / `series` |
| `/api/proxy`'s own m3u8 rewriter | `proxy.ts` | every segment/sub-playlist URL found in a rewritten playlist | inherited from parent (see below) |
| `LiveStreamService.generateSignedUrl` | `LiveStreamService.ts` | `"cmd<_>seq"` segment resourceId | inherited |
| `live.ts`'s own `generateSignedUrl` | `live.ts` | `"cmd<_>seq"` segment resourceId | inherited |
| Legacy M3U export | `getM3uUrls.ts` (`channelToM3u`, `buildLine`) | `channel.cmd` / provider item id | `live` / movie via `/api/vod/play` |

**Segment/sub-playlist tokens must inherit `{kind, label, category}` from the *parent* token, not the whole parent object** — extract just those three fields (see Lessons).

---

## Where tokens get consumed (gates)

All of these call `streamTokenFromRequest(request)` (or `resolveStreamToken(token)` for path-param tokens) and `401`/`403` if resolution fails:

- `GET /api/proxy`, `GET /api/proxy/stream` (`proxy.ts`)
- `GET /portal/proxy` (`portalProxy.ts`) — a second, independent proxy surface found during the security audit, same base64 leak, same fix
- `GET /live.m3u8` (`live.ts`) — token replaces the old `cmd=` query param entirely
- `GET /player/{token}` (`live.ts`) — token replaces the old `resourceId` (plaintext `cmd<_>seq` in the URL path!) + separate HMAC `sig` query param. The token *is* the sole credential now; no separate signature.
- `GET /live-hls/{sessionId}/playlist.m3u8` and `.../{segment}.ts` (`live.ts`, opt-in `LIVE_TRANSCODE` feature)
- `GET /api/vod/play` (`vod.ts`) — token resource is the provider's own movie/item **id** (not a URL); the real URL is resolved fresh via `getMovieLink` inside the handler
- `GET /api/media/info`, `GET /api/media/subtitle` (`subtitles.ts`) — embedded-subtitle probe/extract for progressive video files; token here is identity proof only (same reasoning as the old `master.m3u8`), the actual `url=` stays caller-supplied because ffprobe/ffmpeg need real bytes to inspect, not a title
- `GET /api/v2/download` (`stalkerV2.ts`) — resource is a JSON-encoded `{id, series, isSeries, cmd, path, title}` payload (`mintDownloadToken`), resolved server-side instead of trusting client `id=`/`cmd=`/`path=` query params directly. Previously **not gated at all** — a real open-proxy/SSRF gap (arbitrary `cmd=`/`path=` fetched and streamed back, zero auth) found and closed during a later audit pass. `GET /api/v2/download-link` mints the token — it's a normal JWT-gated `/api/v2/*` route (the download itself is a `window.open` plain navigation, which can't carry a Bearer header, hence the two-step mint-then-navigate flow)

No exceptions remain — every stream-adjacent route requires a per-request token resolving to the exact resource being served.

## Non-stream unauthenticated route: `/api/images/{slug*}`

Poster/logo relay to the active portal (`src/routes/stalkerV2/`) — the one route left unauthenticated, since `<img src>` can't attach a Bearer header or a token either. Originally it forwarded the `slug` path param straight into `http(s)://{portalHost}:{portalPort}/{slug}` with **no restriction**, which made it a general unauthenticated GET relay to the portal's entire HTTP surface (any path, any query string) — not actually pinned to images at all. Fixed by rejecting `..`/`?`/`#` in the path and requiring a real image extension (`png|jpe?g|webp|gif|svg|bmp|ico`). Deliberately *not* token-gated like everything else — posters are low-sensitivity (no credentials/streams exposed) and `<img>` tags can't carry a token without JS-mediated fetch+blob-URL plumbing, which was judged not worth it for this asset class (same tradeoff Netflix/Jellyfin make for poster art).

---

## `StreamTracker` — live "who's watching" (`src/services/StreamTracker.ts`)

HLS/live playback is a stream of short-lived requests (playlist refresh every few seconds, one request per segment), not one long connection — there's no clean "start"/"end" event. Instead:

```ts
streamTracker.touch(type: "proxy"|"live"|"vod", ip, resource, user?, meta?)
```

keyed by `${type}:${ip}:${resource}`, refreshing `lastSeen`. A session is swept if idle > `IDLE_TIMEOUT_MS` (default 60s, tune via `STREAM_IDLE_TIMEOUT_MS` env var — was 20s originally, too short and caused actively-playing streams to disappear from the admin view if the player buffered ahead and went quiet for a while). Swept every 10s.

`user`/`meta` are optional on `touch()` and **preserve the previous value when omitted** — most follow-up requests (segment fetches) don't carry a fresh token with metadata, only the request that started the session does. The resource key stays stable across those follow-ups, so identity/metadata set on the first touch carries forward automatically.

`meta: { kind: "live"|"movie"|"series", label?: string, category?: string }` — `label` is the actual title (not the resolved file/quality variant's own name, see Lessons), `category` is the genre/category name. Both are best-effort; a `null` `kind` falls back to the transport `type` for display.

### Admin API

- `GET /api/admin/streams` (`userManagement.ts`) → `{ count, sessions: StreamSession[] }`
- `GET /api/admin/stats` folds in `activeStreams: streamTracker.count()`

---

## Lessons (real bugs hit while building this — read before touching `meta`)

1. **Resource-overwrite via bad `meta` spread.** `proxy.ts`'s m3u8 rewriter once passed the *entire resolved parent token* as `meta` to `mintStreamToken`/`getProxiedUrl` when minting tokens for segments/sub-playlists. Because `meta` was spread *after* the explicit `resource` param at the time, this silently overwrote every segment's real URL with the parent playlist's URL — every segment request re-fetched the playlist instead of video data. Symptom: playback started, then stopped almost immediately; server log showed the identical upstream URL fetched twice in a row. Fixed two ways: (a) always extract just `{kind, label, category}` before passing as `meta`, never the whole entry; (b) reordered `mintStreamToken`'s object literal so explicit params win regardless of what `meta` contains, as defense in depth.

2. **Resolved file ≠ real title.** For Stalker portals, `getMovies({movieId, seasonId, episodeId})` / `getMovieLink()` return a *file/quality variant* object whose own `name` is often just a quality/language descriptor (e.g. `"Hindi / Excellent quality (1080)"`), not the actual movie/episode title. Building the tracker `label` from that variant's `.title`/`.name` shows garbage in the admin view. The frontend must pass the *real* title explicitly (from the series/episode/movie card, not the resolved playable file) via `resolveStreamUrl`'s `displayOverride` param — see [[skill-video-playback]] in portalcast-webui.

3. **Unsafe "already have the URL" shortcuts.** The frontend used to have `if (!isPortal && item.cmd) return item.cmd directly` shortcuts for Xtream-provider setups, skipping the backend call entirely for movie/episode playback. That's safe *only* for already-tokenized URLs (live channels via `mapChannel`, which now tokenizes for both provider types). For episode/movie *files*, `item.cmd` from the listing API is raw untokenized upstream data — using it directly both leaked the real URL to the browser and broke playback outright (browsers can't play an arbitrary external CDN URL — CORS/host issues). These shortcuts were removed; playback always resolves through the backend now, regardless of provider type.

4. **There's more than one unauthenticated proxy surface.** `/portal/proxy` (`src/routes/portalProxy.ts`) is a second, independent route with the exact same base64-`url=` shape as `/api/proxy` — easy to miss in a security sweep if you only think to check the obvious one. Any future gating/security change to stream routes needs to enumerate *all* proxy-shaped routes (grep for `http.get`/`axios`/`httpClient` fetching a client-supplied URL), not just `proxy.ts`.

5. **Idle timeout too aggressive breaks the "active streams" view, not just cosmetics.** `IDLE_TIMEOUT_MS` started at 20s (matched to a fast-case HLS segment interval) and caused actively-playing streams to disappear from the admin view whenever a player buffered ahead and legitimately went quiet between fetches for longer than that. Tune this to the *slowest* realistic gap between requests for a healthy session, not the fastest — raised to 60s (`STREAM_IDLE_TIMEOUT_MS` env var).

---

## Key Files

- `src/services/StreamTokens.ts` — mint/resolve primitive
- `src/services/StreamTracker.ts` — live session tracking
- `src/routes/proxy.ts` — `/api/proxy`, `/api/proxy/stream`, the m3u8 rewriter
- `src/routes/portalProxy.ts` — `/portal/proxy`
- `src/routes/live.ts` — `/live.m3u8`, `/player/{token}`, `/live-hls/*`
- `src/services/LiveStreamService.ts` — Xtream-provider live HLS proxying
- `src/routes/vod.ts` — `/api/vod/play`
- `src/routes/subtitles.ts` — `/api/media/info`, `/api/media/subtitle` (embedded-subtitle extraction for progressive files)
- `src/routes/stalkerV2/` — `mapChannel`, `/api/v2/movie-link`, `/api/v2/channel-link`, `mintDownloadToken`, `/api/v2/download`, `/api/v2/download-link`, `/api/images/{slug*}` (unauthenticated but extension/path-restricted)
- `src/routes/xtream/` — Xtream player stream endpoints
- `src/providers/getM3uUrls.ts` — legacy plain-M3U export tokenization
