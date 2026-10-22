# Catalog snapshot (2026-10-21)

The whole catalog packed in memory as typed arrays, so pages can be answered without the database (plan Phase 1). Code: `src/content/catalog/`. Setting `catalogSnapshot` (group Catalog, default off, applies on restart).

**Status:** Phase 1b in progress. With the setting on: "All Movies" / "All Series" (pages, search, Discover's open-by-id) read the snapshot (`all.ts`), and so do Discover's cards on browse, rows and recommendations (`cards.ts`). Still on today's code: Discover's ranking and facets (`discoverIndex`), details, variants, person pages, people search. The setting stays off live until those move too and `catalogUnion`, the title search view, `discoverIndex` and the people search index (about 246 MB of heap on the working copy) are removed.

## Files

| File | Owns |
| --- | --- |
| `builder.ts` | `buildSnapshot()`: reads the database in a worker thread, returns the sections |
| `snapshot.ts` | `CatalogSnapshot`: the only reader. Routes call its methods, never index sections themselves |
| `format.ts` | The snapshot file: write, read and verify |
| `changes.ts` | Change capture: triggers that log changed keys to `catalog_changes` |
| `store.ts` | Load at start, rebuild after changes, status for admin; which cache version of each list the snapshot holds |
| `views.ts` | The "All" view: browse with overrides, search, id lookups, changed lists |
| `cards.ts` | Card rows and tags for a page of titles (Discover): the snapshot, or the database for titles changed since it was built |
| `all.ts` | What the routes call for "All": the view when the setting is on, `catalogUnion` when off (the one place that chooses) |

## What is in it

One row per `content_meta` row ("copy"), person, credit and IPTV list entry, as columns:

- **Text** is stored once in a pool (8 MB chunks) and referenced by a 32-bit id. The same plot on three IPTV copies, a poster path, a role name: one copy each. 2.7 million distinct texts on the working copy.
- **Numbers**: whole-number columns are `Int32Array` (NULL = `INT_NULL`) or `Int16Array` when every value fits; others `Float64Array` (NULL = NaN). Dates are epoch milliseconds.
- **Tags** (genre, country, theme): a value dictionary plus offsets both ways, so "tags of a copy" and "copies with a tag" are both a slice.
- **Credits**: grouped by title key in billing order, plus a per-person list.
- **Person details** (birthday, biography...) are sparse: rows only for people that have any.
- **IPTV list entries**: each entry is its key list ("shape", four on live data) plus each value's JSON text from the pool. `listItem(k)` rebuilds the exact cached JSON; `listField(k, key)` reads one value without rebuilding the entry. Each entry's item id, with an index by (type, id).
- **Title search**: built with `normalizeText` from `content/searchIndex.ts` (passed to the worker as source, so there is one normalizer): sorted ASCII vocabulary of words and joined word pairs, postings per term, an exact-term hash table for the typo pass, and each entry's normalized title and year.

Lookups are binary searches over sorted arrays (copy id, person id, title key, TMDB id); no Maps are kept.

## Build

- A worker thread with its own read-only connection, inside one read transaction: the snapshot is one moment of the database, and its version is `MAX(seq)` of `catalog_changes` read in that transaction.
- Reads a page of 4,000 rows at a time, which SQLite packs into one JSON text (`json_group_array`). SQLite's JSON writes a REAL with 15 significant digits (0.1 + 0.2 came back as 0.3), so REALs are sent as `{"r": "<17 digits>"}` and turned back into the exact double. The driver then makes one string per page instead of one value per cell: the raw read went from 18 s to 5.3 s. Paging also bounds the driver's native row queue (streaming with `each` queued rows natively, +863 MB).
- Text interning is an open-addressing table over typed arrays (a `Map` of 2 million strings took most of a 164 MB heap).
- The checksum (sha1) is computed in the worker; the buffers are transferred to the main thread, not copied.
- Never `terminate()` the worker (it holds sqlite3; that aborts the process) and never give it an old-generation memory cap (same).

## File

`<data>/catalog/snapshot-<version>.bin`: header JSON, then each section as raw bytes, 8-byte aligned. Written to a `.tmp` file and renamed. Loading reads and checks the checksum in a worker and transfers the one buffer; the main thread only creates views. A file of another format version, or with a bad checksum, is ignored and the snapshot is rebuilt.

## The "All" view (views.ts)

Same answers as `catalogUnion.ts`, checked three ways: unit tests against `SearchIndex` (`test/catalog-views.test.ts`), a harness on a copy of the live data (every browse entry, every id, about 1,250 searches, with and without overrides, a hidden category and changed lists: all equal), and 267 route answers compared byte for byte with the setting off and on.

- A view per (profile, type) is an index array over snapshot entries: the visible categories in genre order (hidden ones left out at read time, as before). Overrides (hidden, moved, renamed, sorted, moved in) are applied by the rules of `applyOverridesToUnion`, as positions and renames; a page rebuilds only its 14 entries.
- Search is `SearchIndex`'s algorithm on the packed index, restricted to visible entries. The typo pass runs when no visible title has the word as a prefix (the old index only held visible titles, so a word found only in a hidden category must still fall back to one edit). Ties keep list order.
- Changed lists: the snapshot records each list's cache write version before reading. Per request each visible list's version is compared (as the union's fingerprint did). A list written since is read once: equal to the snapshot's (the daily refresh mostly rewrites lists unchanged), it is marked current again; otherwise it is kept, parsed, until the next rebuild. After a restart, the change log names the lists written since the saved file.
- With the setting on the union is never built: requests wait for the snapshot (`catalogReady`), loaded from its file at start. If the snapshot cannot be built at all, the union answers as before.

Measured on the working copy (production build): search p95 35.6 -> 8.8 ms for movies, 1.35 -> 1.50 ms for series, slowest 62 -> 16 ms; route p95 53.6 -> 36.5 ms. Heap for "All": +201 MB (union and its search index) -> +3 MB (views; the snapshot itself is shared by every reader).

## Discover cards (cards.ts)

`titleRows(ids)` gives the content_meta columns and genre/country tags of a page of titles. A title whose row or tags were written after the snapshot was built, or that is not in it, is read from the database. `catalogChanges()` (store.ts) knows which: one indexed read of the change log per call, returning only rows newer than the last call, so a write made a moment ago is seen. Checked with 148 Discover answers (about 5,600 cards) identical off vs on, as stored and after renaming a title, changing a rating and adding a country following the build; median answer 15.1 -> 7.9 ms.

## Changes and rebuilds

- A trigger deletes the key's row and inserts a new one. It never uses `INSERT OR REPLACE`: SQLite applies the outer statement's conflict handling inside triggers, so under an upsert (what `xtreamCache.set` and Sequelize `upsert` send) the trigger aborted the write itself, and under `INSERT OR IGNORE` it kept the old sequence number and lost the change. A NULL key is skipped. Switching on always recreates the triggers (`test/catalog-changes.test.ts`).
- Triggers (installed only while the setting is on) log `title`, `tags`, `person`, `credits`, `override`, `genre_overrides`, `genres` and `list` (only `vod_streams_*` and `series_list_*` cache keys) changes, one row per key.
- `store.ts` polls the version every 5 s; it rebuilds once changes have been quiet for 60 s, and at most every 10 minutes. The old snapshot keeps answering until the new one is ready (swap: under 1 ms).
- A saved file older than the database is served at start (lists are checked per request) while a current one is built in the background.
- Title, tag, credit and person changes between rebuilds: applied by the readers that use them, as each route moves (next: Discover).

## Measured (working copy, 132k copies, 412k people, 1.1M credits, 132k list entries)

| | |
| --- | --- |
| Build | 14.2 s (copies 4.7, tags 0.7, people 1.2, credits 4.4, lists 2.8, finish 0.3) |
| Size | 168 MB (text pool 73 MB) |
| Peak memory while building | +361 MB: the new snapshot plus about 190 MB of build tables (intern table, credit sort, page buffers), freed at the end |
| Main-thread stall during a build | 24 ms |
| Load from file at start | 0.56 s |

Memory budget once Phase 1b removes the old views: about 320 MB steady, about 680 MB at the peak of a rebuild (old and new snapshot side by side), inside the 1 GB container limit.

## Tests

- `test/catalog.test.ts`: a small database with the edge cases (texts across chunk ends with 128-byte chunks, empty vs NULL text, leading BOM, multi-byte text, numbers that do or do not fit 32 bits, orphan tags and credits, sparse person details, list entries of every shape including `null` and arrays, compressed cache values), the file round trip, and a damaged file being refused.
- On a copy of the live data (bench script, not in the repo): every copy and column, every tag in order, credits of 5,000 random titles, every person, every list entry and 296k single fields compared with the database: 0 differences; a reloaded file is identical section by section.
