# Fewer requests: server to portal, apps to server (2026-10-21)

Two goals: the server asks the IPTV portal as little as possible, and the apps ask the server as little as possible. Plan and progress: the "PortalCast Speed Plan" doc.

## Server to portal

| Piece | Where | What it does |
| --- | --- | --- |
| Outbound counter | `src/services/outboundTraffic.ts` | Every request from both axios instances (default and `streaming/httpClient.ts`) is counted by destination: `portal <type>/<action>`, `portal image`, `image proxy`, `portal health`, `tmdb api`, `tmdb image`, `imdb`, `omdb`, `tvmaze`, `stream or other`. Logged hourly as `[outbound] last hour: N requests: ...`; `outboundStats()` for the admin page. `fetch()` calls (portal images) are counted by hand. A request can name its kind with `countAs` in the axios config |
| Portal health | `src/services/portalHealth.ts` | No probe while real traffic shows the portal answering (any answer in the last 5 min, noted by the counter). One probe after 5 quiet minutes; a network failure in real traffic is confirmed by a probe at once; every minute while offline. Was a probe every 60 s |
| Portal images | `cachedRelayImage` in `src/content/imageCache.ts`, used by `/api/images/{slug*}` and `/api/images/proxy` (`routes/stalkerV2/playlist.ts`) | Channel logos and posters of titles not on TMDB: memory, then `<image cache folder>/relay/<xx>/<sha1>`, then the portal once. Missing images remembered 10 min. Apps keep them 30 days (`public, max-age=2592000`, was 1 h). The nightly eviction walks `relay/` too |
| Image sizes (Phase 4, 2026-10-22) | The apps pick the size per use from `/api/images/tmdb/<size>/<file>` (TV `util/ImageUrl.downsize`, webui `utils/imageSize.ts`): cards w342 (webui w500 at 2x), ambient backdrop w780, TV hero/detail backdrops w1280; detail posters w500. `content/posterPrefill.ts` (job "poster-prefill", 02:00) puts every representative title's w342 poster in the cache folder, newest first, 2 a second, at most 3 h a night (88,668 posters on live data: a first pass of a few nights), straight to disk (`prefetchToDisk`), never into the memory cache | Half the bytes per card, a few hundred KB instead of several MB per backdrop; cards already on disk before anyone scrolls to them |
| Detail answers | `detailCacheKey`, `rebaseOrigin`, `DETAIL_CACHE_MS` in `routes/stalkerV2/shared.ts`; used in `movies.ts`, `series.ts` | A series' seasons, a season's episodes and a movie's files are kept 24 h in `content_cache` under `<type>-detail:<movieId>:<seasonId>:<page>` (they used to be written but never read, so every series open asked the portal). Stored with the origin they were built for; image addresses are moved to the asking origin on read. A request for one episode (`episodeId`) stays live: it refreshes play links. Play links (`movie-link`) are always live |

## Apps to server

| Piece | Where | What it does |
| --- | --- | --- |
| `X-IPTV` header | `src/infra/httpCaching.ts` | `online` / `offline` on every `/api` answer, so the apps learn the portal state from requests they make anyway |
| HTTP caching | `src/infra/httpCaching.ts` | Stable GET answers get `Cache-Control: private, max-age=N, must-revalidate`, a weak `ETag` and `Vary: Authorization`; an unchanged answer to `If-None-Match` is a bodyless 304. N: facets 300, details/variants 600, browse/rows/recommendations 60, groups 600, movies/series 60. Answers that set their own `Cache-Control` (EPG, images) are left alone; play links, progress and admin are not in the list |
| Discover rows | `GET /api/v2/discover/rows?genres=a,b,c&type=` (`routes/discover/index.ts`) | Up to 12 genre rows (first page each) in one answer; titles of all rows read in one query. Same rows, order and totals as one `/browse` per genre |

Clients: the webui reads `X-IPTV` from every answer (`api/client.ts onApiHeaders`, `utils/iptvHealth.ts`) and asks `/api/v2/health/iptv` only after 5 quiet minutes; the browser's HTTP cache honours the headers; Discover loads its rows with `/discover/rows`; progress is not saved while paused. The TV reads `X-IPTV` in a network interceptor (`di/AppContainer.kt`, `ui/components/IptvStatus.kt`), has a 50 MB OkHttp disk cache on the API client, and does not save progress while paused.

## Checking it

- `[outbound]` lines in the server log, per hour, by kind.
- Request lines carry their time (`(N ms)`); 304s show as `--> 304`.
