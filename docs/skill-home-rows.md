# Home rows (2026-10-22)

The personal rows of Home/Discover, prepared per viewer (plan Phase 2). Code: `src/content/home.ts`, route `GET /api/v2/home?type=all|movie|series` in `src/routes/discover/index.ts`. A viewer is a user on the active IPTV profile.

## Rows

| Row | From |
| --- | --- |
| Because you watched *X* (up to 3) | The 3 most recently watched titles; each one's most similar titles: shared genres (3 each), people (a director or creator 5, one of the first five billed cast 4), same language (2); at least 6 points; same type |
| Top picks for you | Genre weights of everything watched (a title watched 30 days ago counts half), language weights, the viewer's 10 most-weighted people |
| More with *name* | The person in two or more watched titles with the most weight: their other titles |
| Popular on this server | What other viewers watched in the last 30 days, one vote per viewer |
| Trending now (Phase 6) | The same for everyone: titles first shown in the last six months, most voted first (votes stand in for popularity). Home: "Trending now · Movies" and "· Series" after the personal rows; Movies/Series pages: first |
| Top rated (Phase 6, Movies/Series pages) | IMDb rating among well-known titles (50k votes for movies, 20k for series), TMDB's when fewer than 12 have one |

Charts are folded per title (type + TMDB id) across every copy: versions can sit in separate groups, and ratings are often stored on another version than the representative one. One card per title (its representative copy); hidden titles left out. Made once per catalog change.

Rules: a row needs 6 titles; a title is in at most two rows; only representative titles (one card per title), never a version of something watched, never a hidden title; `type` keeps one type. `genreOrder` lists the viewer's genres, most watched first, for the genre rows the apps page through `/discover/browse`. Continue Watching stays with `GET /api/user/progress`.

"Watched" is the rule recommendations always used (`content/viewers.ts`: completed, or 20% in), now shared.

## Inputs and caching

- Progress from the viewer store (`content/viewers.ts`), ranks, genres and languages from `discoverIndex`, watched titles, their groups and people from `catalog/cards.ts` (the catalog snapshot when on, else the database).
- Rows are cached per viewer and type until any viewer's progress changes (Popular depends on everyone) or the catalog does (`onDiscoverCacheClear` -> `markHomeStale`). A stale answer is served while the new one is built; only a viewer's first open waits.
- The answer carries an ETag of itself: an unchanged Home is a 304.

## Measured (copy of the live data, snapshot on)

Building a viewer's rows: 17-205 ms (most of it waiting on reads), longest main-thread block 29 ms. Every rule above checked for all 5 viewers and the three types (scratch harness).
