# Benchmark harness

Measures the hot `/api/v2` read endpoints against a catalog at the scale of the owner's real
portal, without touching a real portal or the real database.

- `mockXtream.mjs` — dependency-free mock Xtream Codes upstream (`/player_api.php`). Seeded
  PRNG, so every run sees the same catalog: 10,171 live channels in 150 categories, 85,428
  movies in 60 categories (skewed sizes), 10,000 series in 40 categories, and
  `get_short_epg` returning 54 programmes per channel (549,234 programmes; the stored guide is
  46 MB of JSON). The guide is anchored on the hour the bench DB was built, so it stays usable
  for ~a day of reruns.
- `run.mjs` — starts the mock (port 18081) and the server from source (`node --import tsx
  src/server.ts`, port 18080) on a throwaway DB in `<system temp dir>/portalcast-bench`
  (override with `BENCH_DIR`), logs in as admin, and times each endpoint: one *first* request,
  then N warm runs (p50/p95), with wire (gzip) and raw sizes and the server's working set
  after each endpoint.

```bash
node scripts/bench/run.mjs --fresh --label=x   # new DB: create + activate an Xtream profile pointing at the mock,
                                               # run refresh-groups/-channels/-movie-groups/-series-groups,
                                               # warm-xtream-vod/-series and refresh-epg, wait for them, then measure
node scripts/bench/run.mjs --label=x           # reuse the DB (waits for the server's startup warm first)
node scripts/bench/run.mjs --verify            # also check correctness: /epg/window vs a brute-force filter of
                                               # /epg, ids= filter, and hide/rename/unhide reaching the "*" union
#  --runs=10  --port=18080  --mock-port=18081  --verbose (echo server log)
```

Results print as a markdown table and are written to `<BENCH_DIR>/results-<label>.json`,
including a hash of each first response body — compare them across code versions on the same
DB to prove a response did not change (`/channels` differs per run: it carries fresh stream
tokens). Everything the runner starts is stopped when it exits. It needs ~1 GB of RAM at peak
on the old code; a fresh setup takes ~40 s on the current code (~11 min before batching).

To time an older commit on the same DB: `git stash push -- src`, run with a new label,
`git stash pop`.

## Results (2026-10-19, Windows 11 laptop, Node 26, N=10)

Same bench DB for both, measured after the startup warm settled. *first* = first request after
server start (for `*` pages: also the first build of the in-memory union; for `/epg`: the
snapshot is primed at startup).

| endpoint | before first | before p50 / p95 | after first | after p50 / p95 | gzip before → after | raw before → after |
|---|---:|---:|---:|---:|---:|---:|
| `/api/v2/epg` (whole guide) | 2509 | 2461 / 2665 | 37 ¹ | 46 / 57 | 6.80 MB → same | 45.96 MB → same |
| `/api/v2/epg/window?hours=6` | — | — | 21 | 12 / 20 | 1.58 MB | 10.45 MB |
| ↳ revalidation (`If-None-Match`) | — | — | 21 | 5.2 / 5.7 | 0 (304) | 0 |
| ↳ `&ids=` 50 channels | — | — | 21 | 8.8 / 11 | 8.5 KB | 52 KB |
| `/api/v2/channels` | 1074 | 116 / 155 | 695 | 6.9 / 25 | 494 KB → same | 4.48 MB → same |
| `/api/v2/groups` | 23 | 6.1 / 11 | 35 | 5.3 / 7.4 | 2.1 KB | 30 KB |
| `/api/v2/movies?category=*&page=1` | 1207 | 5.9 / 6.5 ² | 358 | 7.6 / 9.5 ² | 980 B | 7.1 KB |
| `/api/v2/movies?category=*&page=50` | 1061 | 6.2 / 6.8 ² | 21 | 5.9 / 7.6 ² | 955 B | 7.1 KB |
| `/api/v2/movies?category=<largest>&page=1` | 139 | 6.3 / 8.5 ² | 153 | 7.2 / 8.2 ² | 980 B | 7.1 KB |
| `/api/v2/movies?category=*&search=night` | 1669 | 327 / 393 | 1098 | 9.1 / 11 | 885 B | 7.0 KB |
| `/api/v2/movies?category=*&search=dark king` | 350 | 318 / 424 | 18 | 8.3 / 11 | 1.0 KB | 6.7 KB |
| `/api/v2/movies?category=*&movieId=…` (Discover open) | 292 | 282 / 359 | 22 | 11 / 16 | 424 B | 424 B |
| `/api/v2/series?category=*&page=1` | 235 | 7.2 / 8.0 ² | 97 | 7.2 / 8.7 ² | 1.7 KB | 9.3 KB |
| `/api/v2/series?category=*&search=storm` | 363 | 56 / 79 | 401 | 8.6 / 12 | 1.7 KB | 9.3 KB |
| `/api/v2/discover/browse?type=movie` (empty: no TMDB) | 15 | 2.4 / 3.3 | 17 | 2.6 / 6.4 | 36 B | 36 B |

¹ fresh-DB run (snapshot primed right after the EPG refresh); on a restart with an existing
guide the startup prime takes ~3.5 s in the background. ² warm runs are ContentCache (DB) hits
in both versions; the union only changes the first/uncached request and every search.
Response bodies of every movies/series/EPG case are byte-identical before and after (hashes).

Memory and setup (fresh DB, same catalog):

| | before | after |
|---|---:|---:|
| catalog warm + EPG fetch (`--fresh` setup) | 658 s | 32 s |
| server working set after warm, idle | ~919 MB ³ | 614 MB |
| peak working set during the endpoint runs | 1565 MB | 831 MB |
| same DB, reused: idle → peak | 381 → 1083 MB | 422 → 710 MB |

³ first sample, taken after the first `/epg` request; the old code holds every
`get_short_epg` response in the Xtream client's 6 h request cache.
