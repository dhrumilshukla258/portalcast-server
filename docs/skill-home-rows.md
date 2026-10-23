# Home rows

The rows of Home and of the Movies / Series pages, prepared per viewer. Code: `src/content/home.ts` (rows, cache, version), `src/content/homeThemes.ts` (title facts, Just added, trending, daily themes), `src/content/homeCharts.ts` (charts per country), `src/content/episodeWatch.ts` (new episodes), `src/content/providerDates.ts` (the provider's dates). Route `GET /api/v2/home?type=all|movie|series` in `src/routes/discover/index.ts`. A viewer is a user on the active IPTV profile.

## Rows

| Row | From |
| --- | --- |
| New episodes | Series the viewer watched whose newest episode is newer than their last watch, in the last 30 days (`content_meta.providerEpisodeAt`, below). First on every page |
| Because you watched *X* (up to 3) | The 3 most recently watched titles; each one's most similar titles: shared genres (3 each), people (a director or creator 5, one of the first five billed cast 4), same language (2); at least 6 points; same type |
| Top picks for you | Genre weights of everything watched (a title watched 30 days ago counts half), language weights, the viewer's 10 most-weighted people; then what is popular out there (TMDB trending, the viewer's countries' charts) adds up to 40 % of the best score, only to titles that already match |
| More with *name* | The person in two or more watched titles with the most weight: their other titles |
| Popular on this server | What other viewers watched in the last 30 days, one vote per viewer |
| Just added | Titles the provider added in the last 30 days, newest first: the provider's own date (`providerAddedAt`), else when this server first saw the title (never the first import) |
| Trending this week | TMDB's weekly trending that this server has (6 h cache); without a TMDB key the vote-based chart (recent titles, most voted first) |
| Daily themes (4) | Chosen per viewer and day: a genre of theirs (classics, hidden gems, recent favourites), a year or a decade, their language ("Best in Hindi") or another genre, a wildcard (sometimes "All-time greats") |
| Charts (2 a day) | For the viewer's countries (from the languages they watch, else the `chartCountry` setting): Netflix's weekly Top 10, in cinemas, popular on the country's top 3 streaming services, series with an episode this week |

Order: Home leads with what the viewer watched (New episodes, Because you watched, Top picks), then Just added, trending, charts and themes between the other personal rows. The Movies / Series pages lead with New episodes and trending.

Rules: a row needs 6 titles (charts fewer); every title is in one row only; only representative titles (one card per title), never a version of something watched (charts and New episodes excepted), never a hidden or Not interested title; `type` keeps one type. `genreOrder` lists the viewer's genres, most watched first, for the genre rows the apps page through `/discover/browse`. Continue Watching stays with `GET /api/user/progress`.

"Watched" is the rule recommendations always used (`content/viewers.ts`: completed, or 20% in).

## Title facts

Year, rating, votes, first seen, the provider's dates, TMDB ids and names (for charts listed by name) per Discover rank, in packed arrays. Read from `content_meta` in pages of 4,000 rows in rowid order (like `catalog/builder.ts`), yielding between pages: about 4 s for 132k rows with no main-thread block over ~0.1 s (it was one 3.5 s block). Built once per catalog change, and 45 s after start-up (`primeHomeFacts`) so the first Home open after a restart does not wait.

## Provider dates and new episodes

- `provider-dates` job (every 6 h): the cached portal lists' dates into `providerAddedAt`, only the ones that changed. A movie keeps its earliest date, a series its latest. Xtream panels' dates arrive in the adapter's `time` field and are read from there (a Stalker `time` is a duration and is never taken as a date).
- `new-episodes` job (every 6 h, each series at most once a day): a series' list date does not move when episodes arrive (on Stalker portals it is when the series was added), so the series viewers watched in the last 30 days and that the current portal lists (at most 60 per run, most recent first) are read again through the background queue (`services/portalPace.ts`, a few requests each). A grown episode list sets `providerEpisodeAt`: the portal's newest episode date, else the time of the check. The first look at a series only records its episode count (or uses the portal's own dates): a series is never called new just because it had not been checked before. Three failures in a row end the run (jobs run one at a time). State: `system_config` key `episode_watch`.

## Caching and versions

- Rows are cached per viewer and type under `homeVersionOf(user, profile)`: the viewer's own history, what anyone has watched (titles becoming watched or removed, which Popular counts; not positions), the catalog (`markHomeStale`), Not interested, the day, TMDB trending and the charts. One viewer's playback (a position every 30 s) changes only their own.
- When it changes, the previous rows are served while new ones are built (only a first open waits). Such an answer is marked `stale` and sent with `Cache-Control: no-cache`, so the apps ask again instead of keeping it.
- `X-Home-Version` (with the in-memory catalog on) is the catalog version plus `homeVersionOf` for the signed-in viewer: a Home asked for at the current version is kept a year (`infra/httpCaching.ts`), and only that viewer's changes replace it. Without a signed-in viewer the header keeps its old form.
- Watched titles' groups (`catalog/cards.ts titleWithGroup`, ~2 ms each from the database) are remembered until the catalog changes.
- The answer carries an ETag of itself: an unchanged Home is a 304.

## Measured (copy of the live data, 132k titles)

A warm build 0.3-0.4 s per viewer and type, longest main-thread block about 30 ms; five viewers' Home rows identical to the previous code at the same clock (scratch harness). Two viewers' versions, positions vs watched titles, and kept vs stale answers checked end to end on an in-process server (scratch harness) and in `test/viewer-generations.test.ts`.
