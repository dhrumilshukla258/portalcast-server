# Titles, grouping and TMDB matching — Skill Reference

How a portal name like `"Zee5 Originals : Maa Hai Na 4K"` becomes a clean title, a group of
versions, a TMDB match and a channel badge — and the rules that keep that from producing
wrong data. Every rule here was measured against a real 117k-title catalog before shipping;
read this before changing any of them.

Related: [[skill-discover]] (where groups and badges are shown), [[skill-database]]
(`content_meta` columns, fix-up steps), [[skill-content-lifecycle]].

---

## Files

- `src/content/channelNames.ts` — curated channel/platform list (`CHANNELS`), `splitChannel()`, `PLATFORMS`. Pure, no imports (titleClean uses it).
- `src/content/channels.ts` — channel logos (TMDB network logo first, live-channel logo second), `isLiveChannel()`.
- `src/content/titleClean.ts` — `stripReleaseNoise()`, `channelOf()`, `normalizeTitleKey()`, language/quality tags.
- `src/content/tmdb.ts` — `tmdbQueries()`, `pickResult()`, `titleYearOf()`, `fetchTvSeason()`, `fetchTvNetworks()`.
- `src/content/tmdbEpisodes.ts` — episode stills/descriptions per season.
- `src/content/metaEnrichment.ts` — `resolveMeta()`, `groupKeyFor()`, `upsertContent()`, the one-time fix-up steps.

## Cleaning a name

`stripReleaseNoise(name)` removes, in order:

1. **A channel or platform prefix** from the curated list (`"HUM TV : X"`, `"Zee5 Originals : X"`, `"Sony Liv : X"`). Only before `:` or `|`; spellings tolerate extra spaces. A channel is never taken off when only a year or a tag would remain (`"Dangal - Telugu"` is a film).
2. **Older channel pattern** (`CHANNEL_PREFIX_RE`): a one-word channel (`Star`, `Colors`, `Sun`) only before `:`/`|`; a multi-word channel name (`Colors Marathi`, `Star Vijay`) with or without one. Without this rule `"Star Wars: …"` lost "Star" and `"Colors of Love"` lost "Colors".
3. **Labels** with no badge: `Turkish Drama :`, `Web Series :`, and a trailing `- Turkish`.
4. **Language and quality tags** (`Hindi`, `Eng Dub`, `South Dub`, `4K`, `HDCAM`, …).

`channelOf(name)` returns the channel only when a real title is left after it. Badges, the Discover **Channel / Platform** filter and logos all use `channelOf`.

**Adding a channel**: add it to `CHANNELS` with every spelling seen on the portal (longest first is automatic). Platforms that are not TV channels also go in `PLATFORMS` (listed in the filter without the Live TV check). Never add franchise-like words (`Star Wars`, `Avatar`, `Amazon`, `Prime`): find candidates by scanning repeated `"X : "` prefixes and sort by hand.

## Grouping versions

`groupKeyFor(type, name, year, tmdbId)`:

- matched: `type:<cleaned name without a trailing year>:tmdb<id>`
- unmatched: `type:<cleaned name>:<year>`

Both the name **and** the TMDB id must agree. Grouping by TMDB id alone merged 2,456 groups of different titles that older searches had given the same id; one card per group would have hidden the rest.

## Matching TMDB

`tmdbQueries(name, year)` tries, most specific first: the cleaned name; without a trailing year; without a `: Season 40 To Current` tail; the part before a colon (exact-name only). `pickResult()` scores by name match, year distance and popularity, and enforces:

- **A year written in the name must agree within one year**, unless TMDB's title is exactly our whole title (`"Blade Runner 2049"`, `"Fear Street: 1994"`, `"Wonder Woman 1984"` are trusted as is). Without this, `"Karz 2002"` matched the 1980 Karz and `"Wonder Woman 1973"` the 2017 film.
- Loosened queries (year or tail removed) accept an exact name match only.

Stored per title besides art and tags: `overview`, `cast`, `director` (a series stores its **creators** there, TMDB `created_by`; clients label it "Created by"), `rating` + `ratingCount` (TMDB vote average and votes), and `imdbId` (from TMDB).

## Details (as detailed as Jellyfin)

One TMDB details call per title (`fetchDetail`, with `credits`, `aggregate_credits` for series, `release_dates` / `content_ratings`, `images`, `external_ids`) gives `TmdbMeta.details`: tagline, age rating (US, else IN, GB, CA, AU), runtime, studios (series: networks), collection, original title, premiere date, logo (English or textless PNG preferred), and people: up to 20 cast with characters and 185 px photos, directors, writers, creators. `storeDetails()` writes the `content_meta` columns (`tagline`, `ageRating`, `runtime`, `studios`, `collection`, `originalTitle`, `premiered`, `logo`, `writers`) and replaces the title's cast and crew in `people` / `title_people`, shared by every copy of the title ([[skill-storage]]); only filled values are written. The one-time step `backfill-details` refetches every matched title by id (newest first, `detailsCheckedAt` marks the ones done). Cards carry the short fields (`tagline`, `rating_mpaa`, `runtime`, `studios`, `collection`, `writers`, `premiered`, `logo_path`); `GET /api/v2/discover/details?id=movie_123` (or `type=&raw=`) gives a detail page everything including cast and crew with photos, taking missing fields from another version of the title.

## Ratings

Every title shows **one** rating, chosen by the server (`bestRating()` in `content/titleRatings.ts`) and sent as `rating_best` + `rating_source`. All versions of a title (one `groupKey`: "ABC HD", "ABC - Hindi", "ABC Dub") show the same rating and details, merged across the group by `groupDataFor()`; Discover cards and the Movies / Series list items (`enrichArtworkFromTmdb` in `routes/stalkerV2/shared.ts`) both carry them, filling the portal's empty description/cast/director. The order:

1. **IMDb** (20+ votes): the most voters and the score people know. Loaded from IMDb's free daily file `title.ratings.tsv.gz` at most once a day (`content/imdbRatings.ts`, personal non-commercial use), matched by the IMDb id TMDB gave us. IMDb has no free API and its pages may not be scraped; the webui links the score to the title's IMDb page.
2. **TMDB** (5+ votes), when IMDb has none.
3. **TVmaze**, for a series TMDB does not know.

Detail pages add the critics' scores **Rotten Tomatoes** and **Metacritic** (`rt_rating`, `metascore`) when OMDb has them (`content/omdb.ts`, by IMDb id only). This needs `OMDB_API_KEY`: one key or several comma-separated (`key1,key2`). A free key allows 1,000 calls a day; each key is used up to `OMDB_DAILY_LIMIT` (default 900) or until OMDb refuses it, then the next. Logs name keys by position, never by value. Never-checked titles go first, newest year first; scores are re-checked after 90 days. Without a key nothing runs.

## TVmaze (series TMDB does not know)

After each enrichment pass `enrichFromTvmaze()` (`src/content/tvmaze.ts`) looks up unmatched series once each (cache key `tvmaze_series_<id>`) on the public TVmaze API, no key, at most 20 calls per 10 s. A show is accepted only under the **exact** same title, and then only when it is the one exact match (and did not premiere after our year), or, among several, its channel or year (within one) fits. It fills empty description, cast, creators, poster and rating only. Most regional daily soaps are not on TVmaze; expect roughly one unmatched series in eight to gain a description.

## Episodes

Episode lists are filled from TMDB's season data: still, overview, runtime, and a real title for placeholder names. The season number comes from the season list the client fetched just before (remembered in memory) or `seasonNumber=`. Episodes never go through the series search.

## One-time fix-up steps

`runFixups()` runs at the start of every `enrichContentMeta()` (startup and daily). Each step is recorded in `SystemConfig` key `meta_fixup_steps` when it finishes and never runs again. Add a new step instead of changing a recorded one.

| Step | What it does |
|---|---|
| `regroup-v1` | recompute every group with `groupKeyFor`, then representatives |
| `regroup-turkish`, `reclean-services`, `reclean-channels-2` | regroup and rename rows a new cleaning rule affects |
| `backfill-credits` | fill empty cast/director/overview from the cached TMDB data and portal plots (nothing fetched) |
| `fix-year-mismatches` | re-search titles whose name year and portal year both disagree with TMDB; else back to portal data |
| `seal-progress-links-2` | seal upstream stream links stored in watch progress (see [[skill-stream-tokens]]) |
| `backfill-ratings-creators` | fetch TMDB details again by id, newest year first, for matched rows without a rating or IMDb id (or series without creators): writes rating, IMDb id, creators, empty cast/overview |
| `retry-unmatched`, `reclean-channels` | search TMDB again for unmatched titles the newer queries can find |

**Before adding a step that rewrites rows**: dry-run it on a copy of a real database and compare counts (empty names, changed groups, overwritten fields). Rewrite only what the new rule is meant to change; fill empty fields rather than overwrite.
