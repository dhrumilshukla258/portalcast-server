# Discover — Skill Reference

Netflix-style genre/country/language/theme browse + "Because You Watched" recommendations, built on top of a TMDB-enriched catalog cache (`ContentMeta`) that sits alongside — not instead of — the existing portal-driven browse (StalkerV2/Xtream).

Related: [[skill-database]], [[skill-xtream-provider]], [[skill-stalker-provider]]

**Status: in progress.** This doc reflects the code as of 2026-07-21; the feature is still being iterated on (see the perf-incident comments throughout the code — this has already been rewritten more than once under real data volume).

---

## Data model

Four tables, all keyed off `ContentMeta.id` (`"movie_{stream_id}"` / `"series_{series_id}"`):

- **`ContentMeta`** (`src/models/ContentMeta.ts`) — one row per catalog item: poster/backdrop (regular + HD-only variant), year, `originalLanguage` (ISO 639-1, TMDB-only field), `tmdbId`, `source` (`tmdb`/`provider`/`none`), `cast`/`director`, `enrichedAt`, `portalCategoryId` (the category it was actually enriched from — not re-derived later, see comments in `metaEnrichment.ts` for why that's unreliable), and the variant-grouping fields below.
- **`ContentGenre`**, **`ContentCountry`**, **`ContentTheme`** (`src/models/`) — one row per `(contentId, value)` tag. Each also carries a denormalized `isRepresentative` boolean mirrored from `ContentMeta` (see Performance below — this is not optional, it's what keeps facet/browse queries off a full join).

### Variant grouping (`groupKey` / `isRepresentative` / `trimmedName`)

Catalogs list the same real title multiple times per language/dub/quality variant (e.g. "ABC Tamil", "ABC South Dub", "ABC Telugu"). To show one card per title:

- `groupKey = "{type}:{normalizeTitleKey(name)}:{year}"` — shared by every variant of the same title. Type- and year-prefixed so an unrelated same-titled movie/series (or a same-titled movie decades apart) never collides.
- `trimmedName = stripReleaseNoise(name)` — case-preserved cleaned title shown to users, computed once at enrichment time (not per-request).
- `isRepresentative` — exactly one `true` row per `groupKey`, recomputed by `recomputeRepresentatives()` (prefers TMDB-sourced, then has a poster, then most recently enriched). Browse/facets/recommendations all filter on this flag; the rest of a group is reachable via `/api/v2/discover/variants`.

## Enrichment pipeline (`src/content/metaEnrichment.ts`)

`enrichContentMeta({ includeBackdropBackfill? })` — **manual trigger only**, never automatic (a full-catalog TMDB backfill takes hours at the throttled rate — `THROTTLE_MS = 350`). Runs, in order:

1. `enrichMovies()` / `enrichSeries()` — walk every genre's cached `vod_streams_*`/`series_list_*` list, skip anything with `enrichedAt` already set, resolve TMDB meta (`resolveMeta()` — TMDB is the only source of `originalLanguage` and themes, so it's always attempted even when the provider already has genre/country), fall back to provider-supplied genre/country when TMDB has no match, then `upsertContent()` (one transaction per title — upsert + all 3 tag-table replacements, to avoid multiple SQLite lock acquisitions per title).
2. `backfillPortalCategoryIds()` — one-time repair for rows enriched before that column existed.
3. `backfillBackdrops()` — only when `includeBackdropBackfill` is passed; re-fetches HD backdrop by stored `tmdbId` for rows still missing one. Excluded from the default path because it can't distinguish "not tried" from "TMDB genuinely has none" — would otherwise refetch the same rows forever.
4. `recomputeRepresentatives()` — two-step raw SQL (reset all, then pick one winner per `groupKey`) + mirrors the flag onto the three tag tables.
5. `clearDiscoverCache()`.

Triggered via `POST /api/admin/content-meta/enrich` (`src/routes/contentmanager/metaEnrichment.ts`); status via `GET /api/admin/content-meta/status`. Guarded by an `isEnriching` flag — re-triggering while a run is in progress is a no-op, not a queued second run.

### Pruning stale items (`pruneContentMeta`)

Called from `routes/stalkerV2/movies.ts`/`series.ts` at click-time when a direct portal lookup for an already-enriched id comes back empty (item removed from the portal). Deletes the `ContentMeta` row + its tag rows, strips the id out of the relevant `vod_streams_*`/`series_list_*` list cache (so it stops surfacing in regular search immediately, not just after the next warm cycle), and — if the pruned row was the group's representative — promotes the next-best surviving variant so the title doesn't vanish from Discover if a still-valid variant exists.

## Routes (`src/routes/discover/index.ts`)

All under `/api/v2/discover/`, gated by the global Bearer-JWT `onPreHandler` in `server.ts` (no per-route `authCheck` needed except `/recommendations`, which needs the decoded user id).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/facets` | Distinct genre/country/theme/language values + counts, for the filter-chip UI |
| `GET` | `/browse` | Paginated `ContentMeta` listing, filterable by any combination of `genre`/`country`/`language`/`theme`/`type` |
| `GET` | `/recommendations` | Per-user "Because You Watched" — genre-overlap ranking from the user's own `UserProgress`, no cross-user data |
| `GET` | `/variants?id=` | All rows sharing the anchor row's `groupKey`, labeled by audio/subtitle language + quality tags |

`toMediaItem()` maps a `ContentMeta` row to the shape the webui's `MediaCard`/`MainContentGrid` already expects — matching the portal catalog's own field conventions (`screenshot_uri`, comma-joined `actors`) so Discover results render through existing components with no special-casing.

### Recommendations logic

Reads up to 40 recent `UserProgress` rows for the active profile, keeps only genuinely-watched ones (`completed`, or ≥20% watched — a few-seconds open/close isn't a taste signal), resolves each to a `ContentMeta` row via `meta.catalogId` (preferred; `movie_/series_{mediaId}` guess as a fallback for progress rows saved before `catalogId` existed), takes the top 5 genres by frequency across up to 20 of those, then ranks *all* matching candidates by genre-overlap count in SQL before limiting to `PAGE_SIZE` — a candidate pool truncated before scoring would silently drop the actual highest-overlap titles. Excludes anything sharing a watched `groupKey` (not just exact id — a different dub of an already-watched title isn't a new recommendation).

## Caching (`src/services/discoverCache.ts`)

A separate in-memory `NodeCache` from `xtreamCache` — this one caches *our own* DB aggregation results (facets/browse are identical for every user, no personalization), not upstream portal responses. `recommendations` is per-user and intentionally never cached here. TTL 10 min as a safety net; `clearDiscoverCache()` is called explicitly at the end of every `enrichContentMeta()` run and from `pruneContentMeta()` so results reflect fresh data immediately rather than waiting out the TTL.

`/browse` additionally caches the *resolved id set* for a given genre/country/theme combination separately from the full page result — without that, paging through the same filter combo re-ran the tag-table lookup + JS intersection on every page even though only the page number changed.

## Performance — read before touching queries here

This endpoint has already taken the server down once and hung indefinitely once. Both incidents came from the same root cause: joining `ContentMeta` to a tag table.

- **2026-07-16**: `facetCounts()` used to join back to `ContentMeta` on every call (including the no-`type` case — 100% of real traffic) just to filter to representative rows. Turned a cheap single-table `GROUP BY` into a full join across `content_genres` (~850k rows) on every Discover page load. Fixed by denormalizing `isRepresentative` directly onto the tag tables (kept in sync by `recomputeRepresentatives()`), so filtering it is now a plain indexed `WHERE` on the table already being queried.
- **2026-07-17**: `/browse` used to join `ContentMeta` → tag table combined with `ORDER BY enrichedAt DESC LIMIT`. SQLite couldn't use an index to jump straight to the top page once a join was involved and had to materialize/sort a much larger joined set first — this never completed under real data volume even with the composite index in place. Fixed by resolving matching `contentId`s from each tag table directly (plain indexed `WHERE`), intersecting in JS, and only then querying `ContentMeta` by `id IN (...)` — no join, so the `enrichedAt` sort stays cheap.

**Rule of thumb**: any new Discover query that needs both a tag-table filter *and* an `enrichedAt`/paginated sort must resolve the tag filter to an id set first (own query, own cache) and intersect in JS — never join the two directly in one query.

## Related but out of scope here

- `src/content/countryNames.ts` (`countryLabel()`, `COUNTRY_NAMES`) — ISO country code → display name, used by `tmdb.ts` (labeling TMDB's `production_countries`) and `db/index.ts` (a one-time migration). Not Discover-specific, just a shared lookup table Discover's `country` facet happens to depend on transitively.
- `src/services/segmentCache.ts` / `RequestMetrics.ts` — separate in-progress work (live-TV segment caching, request metrics), not part of Discover. No skill doc yet.
