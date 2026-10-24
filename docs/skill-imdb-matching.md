# IMDb matching (optional)

Setting **Match titles with IMDb first** (`imdbMatching`, Admin → Settings → Catalog), off by default. When on, the server downloads IMDb's free title files itself (datasets.imdbws.com; personal and non-commercial use) and matches portal titles against them before searching TMDB. Code: `src/content/imdbIndex.ts`; enrichment hook in `src/content/metaEnrichment.ts` (`resolveMeta`, `imdbRetryUnmatched`, `imdbCorrectMatches`); jobs in `src/server.ts`.

## Index (job `imdb-titles`, weekly; at once when the setting is turned on)

A worker thread streams six IMDb files (about 1.9 GB to download: ratings, titles, alternative names, crew, principal cast, people) through gunzip into `imdb.db` next to the database, then swaps it in. Kept: movies and series (no episodes, shorts or adult titles) with at least one vote or from the last two years, under every name they are known by (normalized: no accents, case, apostrophes or punctuation; "&" is "and"; a leading "the" optional), with their year, votes (exact, any size) and rating, and their people: directors and the first ten cast, as 32-bit hashes of their normalized names packed into one row per title (`credits`; names are compared, never kept). Measured: 649,133 titles, 2.05 million names, 5.8 million credits of 1.73 million people; 167 MB; 6-8 min; the server process at about 375 MB during the build. Missing at start-up with the setting on: built 10 minutes after start.

## Match

The known title at the **start** of a portal name (or after a "Channel :" prefix), longest first, of the same type and year (within 1; for a series, within its run), where what is left is only this portal's tags (`titleClean.ts`, Admin → Title words), a year, or a season marker. Scored: a title's own name above another country's name for it; the same year; popularity; and, when the portal sends them, its people and IMDb rating:

| Evidence | Score |
| --- | --- |
| a director shared / a different one | +6 / -3 |
| each shared cast member (up to 3) / none of 3 or more listed | +2 / -2 |
| the portal's IMDb rating equal (within 0.1) / far (over 1.5) | +3 / -1 |

A candidate contradicted by both director and cast is dropped; a confirmed one may have no votes yet (a new film) or a stray year (a shared director). Then TMDB's title for that IMDb id (`/find`) and its details: two calls, no search. Nothing matched, or TMDB does not know the IMDb title: the TMDB search as before.

Measured on a 133,185-name catalog (offline, against titles TMDB had already matched): an IMDb match for 93.3%, the same title as TMDB's for 94.4% of those (96.2% where the portal lists people). 1.1 ms per name. Where the two disagree, the portal's own data judges:

| Judge | IMDb's pick | TMDB's search |
| --- | --- | --- |
| the portal's director and cast | 1,181 | 32 |
| the portal's year (TMDB's pick 2+ years off) | 1,106 | 0 by construction; checked against the people: 307 confirmed, 20 contradicted |

TMDB's search tends to take a famous longer title holding the words ("Little" -> Little Women, "Lion" -> The Lion King, "Peter" -> Peter Rabbit 2).

## Titles TMDB never matched (job `imdb-unmatched`, every 6 h and right after each new index)

400 per run, in id order from where the last run stopped, from the start again after each new index; TMDB is asked only for the ones IMDb found (with the portal's people from its category list). On the same catalog: about 2,100 of 12,400 found (awards shows, specials, new films).

## Matches the portal's own data contradicts (job `imdb-verify`, every 6 h and right after each new index)

2,000 per run (about 8 s; a 118,000-title catalog in about 15 days). A matched title is matched again through IMDb, and logged ("IMDb corrected ... (reason)"), only when TMDB confirms the same IMDb title and either:
- the portal lists people: IMDb's pick shares a director or cast member with them, and the current title (whose people IMDb knows) shares none; or
- the portal lists no people but a year: IMDb's pick fits it by its own year (a series also by a run that has ended) and has 20 votes or more, the current title is 3 years or more away (and, for a series, outside its run), and a year in the name does not disagree with the portal's (either can be the one that is off: an upload year, a re-release). Checked against the people where both exist: 262 confirmed, 4 contradicted (without the vote minimum 264 and 7; with only the 3-year gap 280 and 10).

A title matched to a different TMDB title (here, the year fix, or "Fix match") loses what only the old one had: ratings, trailer, runtime, tagline, logo and the like are cleared and filled again for the new one by the usual backfills; artwork an admin chose stays.

Titles where IMDb and TMDB both fit (the same name in the same year), or nothing decides, are left as they are.

## Fix match (any portal title, IMDb matching on or off)

An admin's **Fix match** on a title's page (next to Edit images) searches TMDB by name, or takes a pasted IMDb id or link, TMDB link or TMDB id, and matches the title to the one picked (`fixPortalMatch`, `routes/admin/titleMatch.ts`). The choice is kept in `content_meta.tmdbIdLocked`: neither this job nor the year fix touches the title again. "Forget my choice" matches it automatically, as when it was new. Local library titles have their own Fix match (Admin → Libraries).

Checked end to end with a stand-in TMDB on the same catalog: every change cost one find and one details call, no searches; by hand, e.g. "Peter - Tamil 4K" from Peter Rabbit 2 to Peter (2026), "Bob Ross : The Joy of Painting" from a 2024 namesake to the 1983 series, "Intervention" from Canine Intervention to Intervention (2005).

Not done: a review list in Admin for the titles nothing decides.
