# Content Lifecycle — Skill Reference

How the server notices content the upstream Stalker/Xtream provider no longer has, and cleans up after it — plus the related but separate table-level cleanup jobs. This logic was scattered across three docs before this session (a `pruneContentMeta()` mention in [[skill-discover]], a stale `XtreamCache` cleanup snippet in [[skill-xtream-provider]], and nothing in [[skill-database]] for the daily purge job) and is consolidated here since it's a cross-cutting concern none of those docs individually own.

Related: [[skill-discover]] (owns `ContentMeta`/tag tables this reads and mutates), [[skill-xtream-provider]] (owns the `XtreamCache` this reads from and the additive warm-cycle this is *not* part of), [[skill-database]] (owns the scheduled `runDbCleanup` job), [[skill-user-system]] (`UserProgress`, cleaned up as part of pruning).

---

## Two different problems, two different mechanisms

1. **"We have a cache/table row that's just old"** — handled by `runDbCleanup()` in `src/server.ts`, a daily interval + startup call. See [[skill-database#Scheduled Cleanup]] for the full table.
2. **"The provider removed a title we still think exists"** — handled by `pruneContentMeta()` + `sweepStaleContent()` in `src/content/metaEnrichment.ts`, described below. This is the harder problem: there's no provider event for "this was deleted," so the server has to notice on its own.

---

## `pruneContentMeta(contentId, portalCategoryId?)`

The single function that removes a title everywhere it's tracked. Two callers trigger it (below); the effect is identical either way:

1. Deletes the `ContentGenre`/`ContentCountry`/`ContentTheme` rows for `contentId` (the Discover genre/country/theme tags).
2. Deletes the `ContentMeta` row itself — this is also where `backdrop`/`backdropHd`/`backdropCheckedAt` live, so backdrop data for a pruned title is removed along with everything else, not left dangling.
3. Deletes any `UserProgress` row with a matching `mediaId` — `UserProgress.mediaId` uses the same `movie_{id}`/`series_{id}` shape as `ContentMeta`'s primary key, so without this a Continue Watching entry for now-gone content would be orphaned forever, pointing at a title that no longer exists anywhere. This check is unconditional (runs even if the `ContentMeta` row was already gone), so it also retroactively catches progress rows orphaned before this cleanup existed.
4. Strips the item out of the category's warmed list cache (`vod_streams_{categoryId}` or `series_list_{categoryId}` in `XtreamCache`) — this is what regular browse/search actually reads from, so without this step the item would vanish from Discover but keep surfacing in normal browsing until the next warm cycle happened to touch that category.
5. If the pruned row was the "representative" for its `groupKey` (the one shown when multiple language/format variants of the same title exist), promotes the next-best sibling variant so the title doesn't just disappear from Discover if a still-valid variant is sitting right there.
6. Clears the Discover response cache (`clearDiscoverCache()`).

### Caller 1 — reactive, on-click (existing, unchanged)

`src/routes/stalkerV2/movies.ts` / `series.ts`: when a direct movie/series-id lookup against the live portal comes back empty (the portal 404s), the route calls `pruneContentMeta()` for that one item before returning. This means a title disappears from Discover/search the moment someone clicks it and it turns out to be gone — much sooner than waiting for any scheduled pass — but it only ever catches titles someone actually still clicks on.

### Caller 2 — proactive, rotating sweep (new this session)

`sweepStaleContent()` (`src/content/metaEnrichment.ts`) exists because the reactive path has an obvious gap: a title nobody clicks again just sits there forever, since nothing else ever proactively checks whether it's still on the provider's side.

**It doesn't reimplement detection — it wraps `catchupScan()`.** `src/services/xtreamCache.ts` already had a `catchupScan()` function that efficiently detects additions/removals: it compares the portal's own reported `total_items` against the locally cached count per category, doing a cheap bounded incremental scan when the portal has *more* (stop once enough new items are found to close the gap), and only paying for a full-page scan when the total has *dropped* (the only way to know exactly which ids are gone). Previously this was wired **only** to the manual admin endpoint `POST /api/v2/catchup-scan` (`src/routes/stalkerV2/maintenance.ts`) and was never scheduled — and, crucially, it only ever reconciled the `XtreamCache` list cache (`vod_streams_*`/`series_list_*`). It never touched `ContentMeta`, the tag tables, or `UserProgress`, so even manually running it kept the raw list accurate but did nothing for the Discover-metadata/Continue-Watching orphan problem.

`catchupScan()` now accepts an optional `CatchupScanOptions`:
- `genreIds?: string[]` — scope the scan to just these categories instead of the whole catalog.
- `onRemoved?: (contentId, categoryId) => Promise<void> | void` — called for every id the scan confirms is gone, *before* it's dropped from the list cache.
- `throttleMs?: number` — pause between each genre's reconcile call.

The manual `/api/v2/catchup-scan` endpoint still calls `catchupScan()` with no arguments, so its existing behavior (full catalog, no throttle, no extra side effects) is unchanged. `sweepStaleContent()` is what actually supplies all three options:

```ts
await catchupScan({
  genreIds: slice,        // this run's rotating 5-category slice
  throttleMs: THROTTLE_MS, // 350ms pace between categories
  onRemoved: async (contentId, categoryId) => {
    await pruneContentMeta(contentId, categoryId); // ContentMeta + tags + UserProgress + list-cache
  },
});
```

**How it stays cheap:**
- Only passes a small rotating slice of **5 categories per run** (`SWEEP_CATEGORIES_PER_RUN`) as `genreIds`, not the whole catalog.
- Persists its position via a cursor in `SystemConfig` (key: `content_sweep_cursor`) — each run picks up where the last one left off, so a full pass over every category completes gradually over many days/weeks instead of one burst. Content removal isn't time-sensitive the way new content is, so a slow rolling sweep is the right tradeoff.
- Within that slice, `catchupScan`'s own total-count-bounded logic keeps most categories cheap (often just a page-1 total-items check); only categories that actually lost content pay for a full-page scan.
- `THROTTLE_MS` (350ms) pace between each of the 5 categories on top of that.

**Wired into:** only the 24h warm-cycle interval in `src/server.ts` — deliberately **not** run at server startup too (an earlier version also fired once on startup "to close the gap sooner," but that's an unnecessary extra portal round-trip on every restart/redeploy for no real benefit, since the interval already covers it regularly). No dedicated route/endpoint; it only runs on this schedule.

**Cursor only advances if the scan actually ran.** `catchupScan()` has a single global in-progress mutex shared with the manual `/api/v2/catchup-scan` endpoint — if the daily sweep happens to fire while an admin has a manual scan running (or an overlapping previous sweep hasn't finished), `catchupScan()` returns `false` without touching anything. `sweepStaleContent()` checks this and skips the `SystemConfig` cursor update in that case, so that day's slice gets retried next run instead of being silently skipped for a full rotation cycle.

---

## Backdrop enrichment — manual-trigger-only, not automatic

Worth stating plainly since it's easy to assume otherwise: `backdropCheckedAt`/`backfillBackdrops()` (`src/content/metaEnrichment.ts`) is **never** part of the automatic startup/24h cycle. `enrichContentMeta()` only runs the backdrop backfill when called with `includeBackdropBackfill: true`, and the *only* caller that ever passes that flag is the manual admin endpoint `POST /api/admin/content-meta/enrich`.

This doesn't mean backdrops are generally missing — most of the catalog gets `backdrop`/`backdropHd` populated automatically as a side effect of the normal TMDB metadata fetch (`resolveMeta()`, which runs on every automatic enrichment pass and pulls both fields from the same TMDB response). `backfillBackdrops()` specifically exists as a narrower *retry pass* for rows enriched by an older version of the code, before `backdrop`/`backdropHd` existed as fields at all — it revisits already-enriched legacy rows using their stored `tmdbId` to fetch just the images, something the normal one-pass-per-row enrichment (which skips anything with `enrichedAt` already set) would never do on its own.

At `THROTTLE_MS` (350ms) pace with no batch cap, backfilling a 100k+ row catalog takes hours — expected to be run once, left running, by an admin, not on any schedule.

---

## Key Files

- `src/content/metaEnrichment.ts` — `pruneContentMeta()`, `sweepStaleContent()`, `backfillBackdrops()`, `enrichContentMeta()`
- `src/services/xtreamCache.ts` — `catchupScan()` (`CatchupScanOptions`: `genreIds`, `onRemoved`, `throttleMs`), `warmVodCache()`/`warmSeriesCache()` (additive-only warm cycle, separate from catchupScan's reconciliation)
- `src/routes/stalkerV2/maintenance.ts` — manual `POST /api/v2/catchup-scan` endpoint (calls `catchupScan()` with no options — full catalog, no throttle, no pruning side effect)
- `src/server.ts` — wiring for `sweepStaleContent`'s 24h interval call (startup-only invocation deliberately removed, see above), plus the unrelated `runDbCleanup()` (see [[skill-database]])
- `src/models/SystemConfig.ts` — stores the sweep's rotating cursor (`content_sweep_cursor`)
- `src/models/UserProgress.ts` — cleaned up by `pruneContentMeta()`, see [[skill-user-system]]
