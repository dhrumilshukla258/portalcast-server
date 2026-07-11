# Database Schema — Skill Reference

SQLite via Sequelize-TypeScript. DB path resolved by `src/db/index.ts`. All models are registered in `sequelize.models` array.

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
| `XtreamCache` | `xtream_cache` | Persistent content cache (24h TTL) |
| `GenreOverride` | `genre_overrides` | Category renames, hides, sort order, virtual categories |
| `ContentOverride` | `content_overrides` | Item renames, hides, moves, sort order |
| `StrmMovie` | `strm_movies` | Tracked .strm file paths for Jellyfin |
| `StrmSeries` | `strm_series` | Tracked .strm series paths |
| `User` | `users` | Auth users (added in `54846ea`) |
| `DeviceCode` | `device_codes` | TV device auth codes (added in `54846ea`) |
| `UserProgress` | `user_progress` | Per-user watch progress (added in `54846ea`) |
| `ContentCache` | `content_cache` | Generic API response cache (added in `d954af5`) |

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

`src/db/index.ts` runs two inline migrations **before** `sequelize.sync({ alter: true })`:

1. **`content_cache` table** — if PK is not `cacheKey`, drop and recreate (added in `d954af5`)
2. **`user_progress` table** — if `profileId` column is missing, drop and recreate (added in `54846ea`)

And one migration that runs **after** `sync()`:

3. **`user_progress` stray unique index repair** — `UserProgress` declares its composite key via three separate `@PrimaryKey` decorators (`userId`, `profileId`, `mediaId`) rather than one true composite index. Sequelize's SQLite `alter` dialect has a known quirk where rebuilding the table this way can leave only `profileId` as a genuinely unique constraint instead of the full composite — which then rejects any second progress row sharing a `profileId` (even for a different user/media) with `SQLITE_CONSTRAINT: UNIQUE constraint failed: user_progress.profileId`.
   **This check must run after `sync()`, not before** — `sync()` is what (re)introduces the stray constraint in the first place, so repairing it beforehand just gets silently undone by the `sync()` call that follows. (This ran in the wrong order for a while, which is why the bug kept resurfacing across restarts even though a fix had already shipped once.) On detection, recreates the table with the correct `PRIMARY KEY (userId, profileId, mediaId)`, preserving all rows via `INSERT OR IGNORE`.

After all migrations: `sequelize.sync({ alter: true })` (called between the "before" and "after" migrations above) adds any missing columns non-destructively.

---

## Key Files

- `src/db/index.ts` — Sequelize setup, model registration, `initDB()`, migrations
- `src/models/` — All model files
- `SQLITE_DB_PATH` env var — override DB location (useful for Docker volumes)