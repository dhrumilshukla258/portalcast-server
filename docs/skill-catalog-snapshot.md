# Catalog snapshot (2026-10-21)

The whole catalog packed in memory as typed arrays, so pages can be answered without the database (plan Phase 1). Code: `src/content/catalog/`. Setting `catalogSnapshot` (group Catalog, default off, applies on restart).

**Status:** built and verified, not used by any route yet. Phase 1b moves the routes onto it and removes the views it replaces (`catalogUnion`, the title search view, `discoverIndex`, the people search index: about 246 MB of heap on the working copy). Until then it stays off: switched on early it would add its memory on top of those views.

## Files

| File | Owns |
| --- | --- |
| `builder.ts` | `buildSnapshot()`: reads the database in a worker thread, returns the sections |
| `snapshot.ts` | `CatalogSnapshot`: the only reader. Routes call its methods, never index sections themselves |
| `format.ts` | The snapshot file: write, read and verify |
| `changes.ts` | Change capture: triggers that log changed keys to `catalog_changes` |
| `store.ts` | Load at start, rebuild after changes, status for admin |

## What is in it

One row per `content_meta` row ("copy"), person, credit and IPTV list entry, as columns:

- **Text** is stored once in a pool (8 MB chunks) and referenced by a 32-bit id. The same plot on three IPTV copies, a poster path, a role name: one copy each. 2.7 million distinct texts on the working copy.
- **Numbers**: whole-number columns are `Int32Array` (NULL = `INT_NULL`) or `Int16Array` when every value fits; others `Float64Array` (NULL = NaN). Dates are epoch milliseconds.
- **Tags** (genre, country, theme): a value dictionary plus offsets both ways, so "tags of a copy" and "copies with a tag" are both a slice.
- **Credits**: grouped by title key in billing order, plus a per-person list.
- **Person details** (birthday, biography...) are sparse: rows only for people that have any.
- **IPTV list entries**: each entry is its key list ("shape", four on live data) plus each value's JSON text from the pool. `listItem(k)` rebuilds the exact cached JSON; `listField(k, key)` reads one value without rebuilding the entry.

Lookups are binary searches over sorted arrays (copy id, person id, title key, TMDB id); no Maps are kept.

## Build

- A worker thread with its own read-only connection, inside one read transaction: the snapshot is one moment of the database, and its version is `MAX(seq)` of `catalog_changes` read in that transaction.
- Reads a page of 4,000 rows at a time, which SQLite packs into one JSON text (`json_group_array`). The driver then makes one string per page instead of one value per cell: the raw read went from 18 s to 5.3 s. Paging also bounds the driver's native row queue (streaming with `each` queued rows natively, +863 MB).
- Text interning is an open-addressing table over typed arrays (a `Map` of 2 million strings took most of a 164 MB heap).
- The checksum (sha1) is computed in the worker; the buffers are transferred to the main thread, not copied.
- Never `terminate()` the worker (it holds sqlite3; that aborts the process) and never give it an old-generation memory cap (same).

## File

`<data>/catalog/snapshot-<version>.bin`: header JSON, then each section as raw bytes, 8-byte aligned. Written to a `.tmp` file and renamed. Loading reads and checks the checksum in a worker and transfers the one buffer; the main thread only creates views. A file of another format version, or with a bad checksum, is ignored and the snapshot is rebuilt.

## Changes and rebuilds

- Triggers (installed only while the setting is on) log `title`, `tags`, `person`, `credits`, `override`, `genre_overrides`, `genres` and `list` (only `vod_streams_*` and `series_list_*` cache keys) changes, one row per key.
- `store.ts` polls the version every 5 s; it rebuilds once changes have been quiet for 60 s, and at most every 10 minutes. The old snapshot keeps answering until the new one is ready (swap: under 1 ms).
- Phase 1b adds the overlay: changes newer than the snapshot are read from the database and applied on top, so readers never see stale data between rebuilds.

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
