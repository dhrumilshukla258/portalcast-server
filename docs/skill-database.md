# Database Schema — Skill Reference

SQLite via Sequelize-TypeScript. DB path resolved by `src/db/index.ts`. All models are registered in `sequelize.models` array.

Related: [[skill-discover]], [[skill-user-system]], [[skill-profiles-epg]], [[skill-content-lifecycle]] (scheduled cleanup + content pruning)

---

## DB Path Resolution

Priority order:
1. `SQLITE_DB_PATH` env var (if points to dir → `{dir}/database.db`; else used as literal path)
2. `./database.db` (if exists)
3. `./database.sqlite` (if exists)
4. Default: `./database.db`

Export: `databasePath` (used by pull-db.sh and diagnostics).

---

## All Models

| Model | Table | Purpose |
|-------|-------|---------|
| `Token` | `tokens` | Stalker auth tokens (restored on startup) |
| `SystemConfig` | `system_config` | Key-value store (playlist cache, vod cache, vod_cat_version) |
| `ConfigProfile` | `config_profiles` | Multi-portal configs (one active at a time) |
| `Channel` | `channels` | Live channels (profile-scoped) |
| `Genre` | `genres` | Channel/VOD/series categories (profile-scoped) |
| `EpgCache` | `epg_cache` | Gzip-compressed XMLTV EPG data |
| `XtreamCache` | `xtream_cache` | Persistent content cache (24h TTL). **Never purged by age** — managed exclusively by the warm cycle's diff logic. (A time-based purge was tried and reverted this session — it deleted write-once per-item rows like `series_info_*` that are never rewritten once complete, forcing a full catalog re-fetch. See `src/server.ts`'s comment on `runDbCleanup`.) |
| `GenreOverride` | `genre_overrides` | Category renames, hides, sort order, virtual categories |
| `ContentOverride` | `content_overrides` | Item renames, hides, moves, sort order |
| `StrmMovie` | `strm_movies` | Tracked .strm file paths for Jellyfin |
| `StrmSeries` | `strm_series` | Tracked .strm series paths |
| `User` | `users` | Auth users (added in `54846ea`) |
| `DeviceCode` | `device_codes` | TV device auth codes (added in `54846ea`). Rows are only deleted on successful pairing — expired/abandoned rows are purged by the daily cleanup job, see [[#Scheduled Cleanup]] |
| `UserProgress` | `user_progress` | Per-user watch progress (added in `54846ea`) |
| `ContentCache` | `content_cache` | Generic API response cache (added in `d954af5`) |
| `ContentMeta` | `content_meta` | TMDB-enriched catalog cache powering Discover — see [[skill-discover]] |
| `ContentGenre` | `content_genres` | Discover genre tags, one row per `(contentId, value)` — see [[skill-discover]] |
| `ContentCountry` | `content_countries` | Discover country tags — see [[skill-discover]] |
| `ContentTheme` | `content_themes` | Discover theme tags (curated TMDB keyword buckets) — see [[skill-discover]] |

---

## Key SystemConfig Keys

| Key | Value |
|-----|-------|
| `playlist_cache` | Last-built live M3U string |
| `vod_cache` | Last-built VOD M3U string |
| `vod_cat_version` | Unix timestamp — bumped when new VOD content found |

---

## Override Tables Detail

### GenreOverride

| Field | Type | Purpose |
|-------|------|---------|
| `genre_key` | STRING PK | `{type}_{id}` e.g. `movie_42` |
| `display_name` | STRING | Renamed title (null = no rename) |
| `hidden` | BOOLEAN | Exclude from responses |
| `sort_order` | INTEGER | Custom position (null = original order) |
| `virtual` | BOOLEAN | User-created category |
| `virtual_title` | STRING | Name of virtual category |

### ContentOverride

| Field | Type | Purpose |
|-------|------|---------|
| `item_key` | STRING PK | `{type}_{id}` e.g. `movie_12345` |
| `item_type` | STRING | `movie`, `series`, or `channel` |
| `display_name` | STRING | Renamed title |
| `hidden` | BOOLEAN | Exclude from responses |
| `target_category_id` | STRING | Category to move item into |
| `original_category_id` | STRING | Source category (saved for restore) |
| `sort_order` | INTEGER | Custom position within category |

Virtual categories have IDs prefixed `vcat_`. The Xtream response normalizes `vcat_*` → bare ID before any portal call.

---

## Migrations (inline in `initDB`)

**`alter: true` is never used, for any model, full stop** (as of 2026-07-22). It used to be a per-model exclusion list, but every model added to that list hit the same root bug: Sequelize's SQLite `alter` rebuilds a table via rename-to-`_backup` → recreate → copy-rows, and that rebuild is unreliable on this stack — it throws on FK-referenced rows, on tables it can't find its own `_backup` copy for, and on anything with more than a trivial PK/unique-index shape. Checked against a live DB copy for every affected model: every column/index each model declares already existed in the real table, meaning `alter` had nothing to legitimately change and was crashing on a pure no-op. Plain `.sync()` still creates a table if it's missing — it just never rebuilds an existing one. **Any new column on any model needs a manual `ALTER TABLE` added to `initDB()`, same as the `content_meta`/`users` examples below — that's the only supported path for schema changes to an existing table now, not a fallback.**

Startup order in `initDB()`:

1. **`PRAGMA journal_mode=WAL` / `PRAGMA busy_timeout=5000`** — re-issued every startup (cheap, idempotent; WAL is a property of the DB file that persists across restarts, but re-setting it costs nothing). WAL lets readers avoid blocking on writer locks — fixed a real incident where Discover queries stalled 7+ seconds under concurrent background-write load.
2. **`user_progress` — fully hand-managed, not synced at all.** `UserProgress` declares its composite key via three separate `@PrimaryKey` decorators, and Sequelize's SQLite alter-via-rebuild throws on that shape (a stray standalone `UNIQUE` constraint on just `profileId` gets derived, which then rejects any second progress row sharing a `profileId` across different users/media). Since `alter` can't touch this table at all, it's excluded from the per-model sync loop below entirely — `initDB()` runs a raw `CREATE TABLE IF NOT EXISTS` for it directly (dropping and recreating first, losing all watch history, only if an existing table is missing `profileId` — a genuinely old pre-migration shape). **Any future column added to `UserProgress` needs its own manual `ALTER TABLE` here, since `sync()` will never see this table again.**
3. **Indexes** — `content_meta.enrichedAt`, `content_meta.groupKey` (both `CREATE INDEX IF NOT EXISTS`, added after real perf incidents where their absence caused full-table scans), plus a composite `(value, contentId)` index on each of `content_genres`/`content_countries`/`content_themes`. Run before the sync loop below — even with `alter: false`, `sync()` still tries to (re)create each model's declared indexes, which throws "no such column" if a brand-new column (e.g. `isRepresentative`) doesn't exist in the real table yet.
4. **Per-model sync loop** — `for (const model of sequelize.models) model.sync({ alter: false })`, one model at a time (not a single `sequelize.sync()` call for everything) — a single call aborts entirely on the first model that throws, silently blocking every model queued after it. One bad table's quirk should never block every other table. `UserProgress` is explicitly skipped (see #2).
5. **`recomputeRepresentatives()`** — runs unconditionally every startup (cheap — two indexed queries), and also after every `enrichContentMeta()` cycle ([[skill-content-lifecycle]]). This one is genuinely ongoing, not a backfill: content keeps arriving continuously via the warm cycles, which shifts which row is the "best" representative per `groupKey` group, so it has to be recomputed whenever the underlying data changes rather than once.

**One-time backfills/purges that have since been removed** (2026-07-22, after confirming their target data was fully migrated on the single production DB): the `content_meta.backdropCheckedAt` `ADD COLUMN` + backfill, the `groupKey`/`trimmedName` backfill loop, `cleanupGenreNoise()` (rewrote raw provider-category noise like "Hindi Web Series" into `Uncategorized` — `metaEnrichment.ts` no longer writes that noise going forward, so it had no future job once the historical rows were fixed), the `content_countries` ISO-code normalization, and the marker-gated `ContentCache` purge (`content_cache_purged_image_proxy_fix`). If a future column/data-shape change needs the same kind of one-time fix, follow the same pattern: guard it with a `SystemConfig` marker row (or a `WHERE ... IS NULL`-style guard) so it's cheap to leave running until it's confirmed complete, then delete it from `initDB()` — don't leave finished one-time migrations running forever.

### content_meta / Discover schema (added incrementally, still present)

Added alongside the Discover feature ([[skill-discover]]):

- `groupKey`, `isRepresentative`, `trimmedName`, `portalCategoryId`, `backdrop`, `backdropHd`, `cast`, `director` columns on `content_meta`, plus `isRepresentative` on `content_genres`/`content_countries`/`content_themes` (denormalized copy — see [[skill-discover]]'s Performance section for why) — these are normal model-declared columns now, created via the per-model sync loop like any other column, not a startup migration step
- Indexes on `content_meta.enrichedAt`, `content_meta.groupKey`, and a composite `(value, contentId)` index on each tag table (step 3 above) — added after two separate perf incidents where missing indexes caused full-table scans/joins under real data volume

---

## Scheduled Cleanup (`runDbCleanup`, `src/server.ts`)

Separate from the startup migrations above — this is a recurring job (`setInterval`, every 24h, plus once at startup) that purges rows nothing else ever deletes:

| Table | Rule |
|-------|------|
| `EpgCache` | Rows with `updatedAt` older than 7 days |
| `DeviceCode` | Rows with `expiresAt` in the past (the successful-pairing path already deletes its own row immediately — anything left past expiry is an abandoned/expired pairing attempt; TV pairing/QR sign-in is actively used, so these genuinely accumulate) |

`XtreamCache` is **deliberately not purged here at all**, despite genuinely accumulating unbounded per-item rows over time (see [[skill-content-lifecycle]] for that gap) — a time-based purge was added, then reverted the same session. It's a real incident worth knowing before trying again: even scoped to only `vod_streams_*`/`series_list_*` list-cache keys with a 7-day-stale grace period, the *first* version of this purge had no key filter at all and also deleted per-item detail rows (`series_info_*`, `vod_info_*`, `vod_cmd_*`, `ep_info_*`, `ep_cmd_*`) that are write-once — never rewritten again once complete, so their `expiresAt` freezes forever and they cross any age-based threshold eventually regardless of still being actively read. Deleting them forced `warmSeriesInfoCache()` (see [[skill-xtream-provider]]) to rebuild the entire series catalog from scratch on the next warm cycle — hours of unnecessary re-fetching, observed directly in production logs. Any future attempt at cleaning up `XtreamCache` needs to either scope to list-cache keys only (as the reverted version did) or, better, track a real "last read" timestamp instead of relying on `expiresAt`/last-write age at all.

This job only ever purged `EpgCache`; `DeviceCode` was added once confirmed to grow unbounded with no other cleanup path. See [[skill-content-lifecycle]] for the content-removal side (pruning `ContentMeta`/tags/`UserProgress` for titles the provider no longer has, via the `sweepStaleContent`/`catchupScan` rotation — the one stale-removal mechanism actually worth keeping), which is a related but separate mechanism from this table-level purge.

---

## Key Files

- `src/db/index.ts` — Sequelize setup, model registration, `initDB()`, migrations
- `src/server.ts` — `runDbCleanup()` (scheduled purges, see above)
- `src/models/` — All model files
- `SQLITE_DB_PATH` env var — override DB location (useful for Docker volumes)