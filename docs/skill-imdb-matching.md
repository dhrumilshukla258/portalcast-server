# IMDb matching (optional)

Setting **Match titles with IMDb first** (`imdbMatching`, Admin → Settings → Catalog), off by default. When on, the server downloads IMDb's free title files itself (datasets.imdbws.com; personal and non-commercial use) and matches portal titles against them before searching TMDB. Code: `src/content/imdbIndex.ts`; enrichment hook in `src/content/metaEnrichment.ts` (`resolveMeta`, `imdbRetryUnmatched`); jobs in `src/server.ts`.

## Index (job `imdb-titles`, weekly; at once when the setting is turned on)

A worker thread streams `title.ratings`, `title.basics` and `title.akas` (about 750 MB to download) through gunzip into `imdb.db` next to the database, then swaps it in. Kept: movies and series (no episodes, shorts or adult titles) with at least one vote or from the last two years, under every name they are known by (normalized: no accents, case, apostrophes or punctuation; "&" is "and"; a leading "the" optional). Measured: 649,133 titles, 2.05 million names, 135 MB, 174 s, the server process at 319 MB during the build. Missing at start-up with the setting on: built 10 minutes after start.

## Match

The known title at the **start** of a portal name (or after a "Channel :" prefix), longest first, of the same type and year (within 1; for a series, within its run), where what is left is only this portal's tags (`titleClean.ts`, Admin → Title words), a year, or a season marker. A title's own name ranks above another country's name for it; an unknown title (no votes) only with the same year. Then TMDB's title for that IMDb id (`/find`) and its details: two calls, no search. Nothing matched, or TMDB does not know the IMDb title: the TMDB search as before.

Measured on a 133,185-name catalog (offline, against titles TMDB had already matched): an IMDb match for 93.2%, the same title as TMDB's for 94.4% of those; where the two disagreed, hand-checked samples had IMDb right about 3 times as often (TMDB's search tends to pick a famous longer title holding the words: "Little" -> Little Women). 1.1 ms per name.

## Titles TMDB never matched (job `imdb-unmatched`, every 6 h)

400 per run, in id order from where the last run stopped, from the start again after each new index; TMDB is asked only for the ones IMDb found. On the same catalog: 2,176 of 12,450 found (awards shows, specials, new films). Checked end to end with a stand-in TMDB: every IMDb hit cost one find and one details call, no searches, and was saved.

Not done (later): director and cast as evidence (the cast files are 1.1 GB more), a review list for titles where IMDb and TMDB disagree. Existing matches are never changed by this.
