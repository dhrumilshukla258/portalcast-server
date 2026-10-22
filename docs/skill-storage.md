# Storage layout (2026-10-21)

How title data is stored after the storage migration (`src/db/storageMigrations.ts`). On a copy of the live database it took the file from 1,032 MB to 402 MB in 3.1 minutes.

## Tables

| Table | One row per | Notes |
| --- | --- | --- |
| `content_meta` | Catalog copy (IPTV entry or library title) | Details, artwork, ratings, `trailerKey`; copies of a title share a `groupKey` |
| `people` | Person | `tmdbPersonId` (unique), name, photo (TMDB w185 photos stored as the file path, `content/people.ts` expands them) |
| `title_people` | Person in a title | `titleKey` = `movie:<tmdbId>` / `series:<tmdbId>`, or the content id for a title TMDB does not know; a locked NFO keeps its own list under the copy's content id, read first |
| `episode_index` | IPTV episode | `episodeId` (integer key), `seriesId`, `episode` number (`content/episodeIndex.ts`) |
| `xtream_cache` | Cache key | Values over 2 KB stored zlib-compressed as BLOBs; `services/xtreamCache.ts` reads both forms |

## What the migration removed

- `ep_info_*` (one row per episode) became `episode_index`.
- `vod_cmd_*`, `ep_cmd_*`: written but never read since the Xtream emulation was removed.
- `vod_info_*`: its two uses (stream label, broken-stream check) read the in-memory catalog (`catalogUnion.catalogItem`).
- `tmdb_web_*`: catalog pages read artwork and trailers from `content_meta` instead of a separate TMDB search per item.
- Full raw TMDB answers (`tmdb_movie_*`, `tmdb_tv_*`) of enriched titles; "not found" answers stay, so failed searches are not repeated.
- Expired `content_cache` rows (pruned nightly now), and the unused tables `content_meta_backup`, `strm_movies`, `strm_series`.
- `content_people` (one row per person per copy) became `people` + `title_people`.

`series_info_*` and the category lists are kept (compressed): `warmSeriesInfoCache()` decides what to fetch from `series_info_*`, and deleting it once forced a full rebuild (see [[skill-database#Scheduled Cleanup]]).

## How the migration runs

At startup, after settings load and before the server listens: a full copy of the database is saved (`backupBeforeChange("storage-migration")`), then each step runs once and is recorded in `system_config.storage_migrations`. Every step is safe to run again (tested: a second run changes nothing), so a start interrupted halfway finishes on the next one.

## No repeated data: keys the database enforces (2026-10-21)

Each table has a natural key, and the database refuses a second row with it. Writers use `INSERT OR IGNORE` / upserts, never "read, check, insert".

| Table | Unique key | Index | Owner (only writer) |
| --- | --- | --- | --- |
| `content_genres`, `content_countries`, `content_themes` | (value, contentId) | `idx_<table>_value_contentId` (UNIQUE) | `content/tags.ts` |
| `title_people` | (titleKey, kind, personId, role) | `idx_title_people_title` (UNIQUE, `IFNULL(role, '')`) | `content/people.ts` |
| `people` | TMDB person id | `tmdbPersonId UNIQUE`; `idx_people_name` for name lookups | `content/people.ts` |

- `content/tags.ts` replaces a title's tags as a set, each value once (TMDB and NFO lists can repeat a genre; that is how 8 repeated rows got in).
- A name-only credit (NFO cast, no TMDB id) is the TMDB person when the full name has two or more words and exactly one TMDB person carries it; otherwise a separate name-only person. One-word and shared names are never guessed.
- `test/ownership.test.ts` fails if any other module writes these tables (`npm test`; it also checks its own patterns catch the write forms used here).
- Storage steps `unique-tags`, `unique-credits`, `merge-name-only-people` converted the live data (on the working copy: 8 repeated tag rows removed, 0 repeated credits, 40 name-only persons merged; 9 s plus the backup).
- All of this packed in memory for reading: [[skill-catalog-snapshot]].

## Nightly jobs

- "Remove unused cast lists" (`tidyPeople`): lists of titles no longer in the catalog, then persons in no list.
- "Remove expired page answers": expired `content_cache` rows.
- "Check stored data for repeats" (`services/integrity.ts`, 05:00): counts repeated tags and credits, orphan tags, name-only duplicates and split titles on its own read-only connection (about 3 s, never blocking requests); repairs orphan tags and name-only duplicates through their owners; anything left shows in admin Overview "Needs you" (`dataIssues`). Split titles (4,359, kept apart on purpose) are reported, not counted as problems.

## Tests run on a copy of the live data

- 936,536 episodes: same series and number as the old rows.
- 19,994 compressed values: decompress to byte-identical originals.
- Cast lists of 6,000 random titles, as the detail page shows them: 5,989 identical; the rest are another copy's list of the same TMDB title, or a person's newer name or photo.
- 26 routes answered by the old code on the original database and the new code on the migrated copy: identical except catalog pages, which now carry TMDB artwork, backdrops and trailers from `content_meta`.
