import { withBusyRetry } from "@/infra/busyRetry";
import { lockOf } from "@/content/customArt";
import { ContentPerson } from "@/models/ContentPerson";
import type { TitleDetails } from "@/content/tmdb";
import { setting } from "@/config/settings";
import { enrichFromOmdb } from "@/content/omdb";
import { syncImdbRatings } from "@/content/imdbRatings";
import { findTvmazeShow } from "@/content/tvmaze";
import { sealCmd, isUpstreamLink } from "@/infra/sealedCmd";
import { channelOf } from "@/content/titleClean";
import { Op, Transaction } from "sequelize";
import { xtreamCache, catchupScan } from "@/services/xtreamCache";
import { readGenres } from "@/infra/storage";
import { logger } from "@/infra/logger";
import { fetchMovieMeta, fetchTVMeta, fetchMetaByTmdbId, TmdbMeta } from "@/content/tmdb";
import { themesForKeywordIds } from "@/content/themes";
import { ContentMeta, ContentType, ContentMetaSource } from "@/models/ContentMeta";
import { ContentGenre } from "@/models/ContentGenre";
import { ContentCountry } from "@/models/ContentCountry";
import { ContentTheme } from "@/models/ContentTheme";
import { UserProgress } from "@/models/UserProgress";
import { SystemConfig } from "@/models/SystemConfig";
import { clearDiscoverCache } from "@/services/discoverCache";
import { normalizeTitleKey, stripReleaseNoise } from "@/content/titleClean";
import { tmdbQueries, titleYearOf } from "@/content/tmdb";

/**
 * The key language/format variants of one title share: the cleaned name plus, when TMDB
 * matched it, the TMDB id (else the year). Both must agree, so "Kim's Convenience" and
 * "Kim's Convenience 2016" (same name once the glued-on year is gone, same TMDB show) are
 * one title with two versions, while two different titles that an old search wrongly gave
 * the same TMDB id ("Officer" and "An Officer and a Gentleman") stay separate. Grouping by
 * TMDB id alone merged 2,456 such groups on the live catalog (2026-10-20).
 */
const TRAILING_YEAR = /[\s_\-]*[(\[]?(?:19|20)\d{2}[)\]]?\s*$/;
export function groupKeyFor(type: ContentType, name: string, year: string | null | undefined, tmdbId?: number | null): string {
  if (!tmdbId) return `${type}:${normalizeTitleKey(name)}:${year || ""}`;
  const key = normalizeTitleKey(name);
  const noYear = key.replace(TRAILING_YEAR, "").trim() || key;
  return `${type}:${noYear}:tmdb${tmdbId}`;
}

// Single catch-all genre tag for titles whose only "genre" signal is a
// provider category label (e.g. "Hindi Web Series", "Urdu Tv Show") — the
// provider's genres_str/genre field is literally its category name, a
// <language> + <content-format> label, never a real genre. These are
// typically the exact regional titles TMDB has no match for at all, so
// dropping them to zero genres would make them unreachable via the genre
// facet entirely — tagging them into one dedicated bucket instead keeps them
// reachable via a single clean filter chip rather than leaking dozens of
// distinct noise values into the genre facet.
export const UNCATEGORIZED_GENRE = "Uncategorized";

function resolveFallbackGenres(fallbackGenres: string[]): string[] {
  return fallbackGenres.length > 0 ? [UNCATEGORIZED_GENRE] : [];
}

// Same pace as the existing warmSeriesInfoCache() TMDB/portal throttle in xtreamCache.ts —
// a full-catalog backfill (100k+ movies) at this rate takes hours, which is expected and
// why this only ever runs on manual trigger, never automatically.
const THROTTLE_MS = 350;
const LOG_EVERY = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractYear(str: any): string {
  const m = String(str || "").match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function splitList(raw: any): string[] {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function replaceTags(Model: typeof ContentGenre | typeof ContentCountry | typeof ContentTheme, contentId: string, values: string[], transaction: Transaction): Promise<void> {
  await Model.destroy({ where: { contentId }, transaction });
  if (values.length > 0) {
    await Model.bulkCreate(values.map((value) => ({ contentId, value })), { transaction });
  }
}

interface Resolved {
  poster: string | null;
  backdrop: string | null;
  backdropHd: string | null;
  year: string;
  originalLanguage: string | null;
  tmdbId: number | undefined;
  source: ContentMetaSource;
  genres: string[];
  countries: string[];
  themes: string[];
  cast: string | null;
  director: string | null;
  overview: string | null;
  rating: number | null;
  ratingCount: number | null;
  imdbId: string | null;
  details: TitleDetails | null;
}

/** The portal's own plot, when it is a real sentence ("-" and blanks are not). */
function portalPlot(item: any): string | null {
  const p = String(item?.plot ?? item?.description ?? "").trim();
  return p && p !== "-" && p.toLowerCase() !== "no description available" ? p : null;
}

// TMDB is the only source for original_language (no provider ever supplies it) and themes
// (TMDB keywords), so it's always attempted — provider genre/country only fills in when
// TMDB has no match at all, not used as a reason to skip the TMDB call.
async function resolveMeta(
  kind: "movie" | "tv",
  cacheKey: string,
  name: string,
  year: string,
  fallbackGenres: string[],
  fallbackCountries: string[],
  fallbackPoster: string | null,
  fallbackOverview: string | null = null,
): Promise<Resolved> {
  let tmdb = await xtreamCache.get<TmdbMeta | { _not_found: true }>(cacheKey);

  // tmdb_movie_*/tmdb_tv_* cache keys are shared with the pre-existing on-demand detail-page
  // lookups (routes/stalkerV2/shared.ts), which have populated
  // this cache since long before genres/countries/keywordIds/originalLanguage existed on
  // TmdbMeta. A cache hit can be one of those older entries missing every field this session
  // added. Since genre/language/theme IS the entire point of enrichment, silently accepting
  // a poster-only legacy entry would permanently leave that title without them (xtreamCache
  // entries don't expire on plain .get() reads) — treat a legacy-shaped hit as a miss and
  // re-fetch fresh instead of degrading quietly.
  const isLegacyShape = tmdb && !("_not_found" in tmdb) && (!("originalLanguage" in tmdb) || !("releaseYear" in tmdb) || !("rating" in tmdb) || !("imdbId" in tmdb) || !("details" in tmdb));
  if (!tmdb || isLegacyShape) {
    const fetched = kind === "movie" ? await fetchMovieMeta(name, year) : await fetchTVMeta(name, year);
    tmdb = fetched || { _not_found: true };
    await xtreamCache.set(cacheKey, tmdb);
    await sleep(THROTTLE_MS);
  }

  if (tmdb && !("_not_found" in tmdb)) {
    return {
      poster: tmdb.poster || fallbackPoster,
      backdrop: tmdb.backdrop || null,
      backdropHd: tmdb.backdropHd || null,
      // Prefer TMDB's own resolved release year over whatever (if anything)
      // was extracted from the raw provider title text — two catalog entries
      // for the same real title can differ in whether their raw text had a
      // parseable year at all, which used to silently produce two different
      // groupKeys for what TMDB confirms is the same title.
      year: tmdb.releaseYear || year,
      originalLanguage: tmdb.originalLanguage ?? null,
      tmdbId: tmdb.tmdbId,
      source: "tmdb",
      genres: tmdb.genres.length > 0 ? tmdb.genres : resolveFallbackGenres(fallbackGenres),
      countries: tmdb.countries.length > 0 ? tmdb.countries : fallbackCountries,
      themes: themesForKeywordIds(tmdb.keywordIds),
      cast: tmdb.cast,
      director: tmdb.director,
      overview: tmdb.overview || fallbackOverview,
      rating: tmdb.rating ?? null,
      ratingCount: tmdb.ratingCount ?? null,
      imdbId: tmdb.imdbId ?? null,
      details: tmdb.details ?? null,
    };
  }

  return {
    poster: fallbackPoster,
    backdrop: null,
    backdropHd: null,
    year,
    originalLanguage: null,
    tmdbId: undefined,
    source: fallbackGenres.length > 0 || fallbackCountries.length > 0 ? "provider" : "none",
    genres: resolveFallbackGenres(fallbackGenres),
    countries: fallbackCountries,
    themes: [],
    cast: null,
    director: null,
    overview: fallbackOverview,
    rating: null,
    ratingCount: null,
    imdbId: null,
    details: null,
  };
}

async function upsertContent(contentId: string, type: ContentType, name: string, resolved: Resolved, categoryId: string): Promise<void> {
  // One transaction for the whole title (upsert + all 3 tag replacements)
  // instead of 4+ separate autocommitted writes — SQLite only allows one
  // writer at a time even under WAL, so each separate write is its own
  // chance to collide with a concurrent user-facing write (e.g. a progress
  // save). Batching cuts that from ~4 lock acquisitions per title to 1,
  // without changing what gets written.
  await ContentMeta.sequelize!.transaction(async (transaction) => {
    // Custom artwork (content/customArt.ts) survives every refresh: kept aside, put back.
    const before = await ContentMeta.findByPk(contentId, { attributes: ["poster", "backdrop", "backdropHd", "logo", "artLocked"], transaction });
    const lock = lockOf(before);
    await ContentMeta.upsert({
      id: contentId,
      type,
      name,
      poster: resolved.poster,
      backdrop: resolved.backdrop,
      backdropHd: resolved.backdropHd,
      year: resolved.year,
      originalLanguage: resolved.originalLanguage,
      tmdbId: resolved.tmdbId,
      source: resolved.source,
      enrichedAt: new Date(),
      // Prefixed with `type` and `year` — a movie and a series sharing the same
      // title (e.g. two completely unrelated "Ride or Die" entries) would
      // otherwise share a groupKey, and so would two totally unrelated shows
      // that happen to reuse a title years apart (e.g. "Bodies" 2004 vs.
      // "Bodies" 2023) — both would get treated as language/format "variants of
      // the same title" by /discover/variants, which only makes sense within
      // one real title. Legitimate variants (same film dubbed into different
      // languages) share the same production year, so this doesn't split those
      // apart. See db/index.ts's one-time migration for existing rows.
      groupKey: groupKeyFor(type, name, resolved.year, resolved.tmdbId),
      trimmedName: stripReleaseNoise(name),
      portalCategoryId: categoryId,
      cast: resolved.cast,
      director: resolved.director,
      overview: resolved.overview,
      // Only when known: a cached TMDB result from before ratings were stored has none, and
      // must not blank a rating the backfill already wrote.
      ...(resolved.rating != null ? { rating: resolved.rating, ratingCount: resolved.ratingCount } : {}),
      ...(resolved.imdbId ? { imdbId: resolved.imdbId } : {}),
    }, { transaction });
    if (resolved.details) await storeDetails(contentId, resolved.details, transaction);
    const keep: Record<string, any> = {};
    if (lock.poster) keep.poster = before!.poster;
    if (lock.backdrop) { keep.backdrop = before!.backdrop; keep.backdropHd = before!.backdropHd; }
    if (lock.logo) keep.logo = before!.logo;
    if (Object.keys(keep).length) await ContentMeta.update(keep, { where: { id: contentId }, transaction });
    await replaceTags(ContentGenre, contentId, resolved.genres, transaction);
    await replaceTags(ContentCountry, contentId, resolved.countries, transaction);
    await replaceTags(ContentTheme, contentId, resolved.themes, transaction);
  });
}

/**
 * Matches and stores one local-library title (content/library): the same TMDB matching and
 * catalog row as an IPTV title, under the "local" category, so it groups with the IPTV
 * versions of the same title. A TMDB id from the folder name, an NFO or "Fix match" is used
 * as is instead of a search. Returns the TMDB id it matched, if any.
 */
export async function enrichLocalTitle(opts: {
  contentId: string;
  type: ContentType;
  name: string;
  year: string | null;
  tmdbId?: number | null;
}): Promise<number | undefined> {
  const kind = opts.type === "movie" ? "movie" : "tv";
  const cacheKey = `tmdb_local_${opts.contentId}_${opts.tmdbId ?? "search"}`;
  if (opts.tmdbId) {
    const cached = await xtreamCache.get<any>(cacheKey);
    if (!cached || (!("_not_found" in cached) && !("imdbId" in cached))) {
      const meta = await fetchMetaByTmdbId(kind, opts.tmdbId);
      await xtreamCache.set(cacheKey, meta || { _not_found: true });
      await sleep(THROTTLE_MS);
    }
  }
  const resolved = await resolveMeta(kind, cacheKey, opts.name, opts.year || "", [], [], null, null);
  await upsertContent(opts.contentId, opts.type, opts.name, resolved, LOCAL_CATEGORY);
  return resolved.tmdbId;
}

/** The catalog category of every local-library title ("My Library" in the apps). */
export const LOCAL_CATEGORY = "local";

/**
 * Writes a title's detail-page data (tagline, age rating, runtime, studios, collection,
 * logo, writers) and replaces its cast and crew (content_people). Only filled values are
 * written, so a sparse source never blanks what is there.
 */
export async function storeDetails(contentId: string, d: TitleDetails, transaction?: Transaction): Promise<void> {
  const patch: Record<string, any> = { detailsCheckedAt: new Date() };
  if (d.tagline) patch.tagline = d.tagline;
  if (d.ageRating) patch.ageRating = d.ageRating;
  if (d.runtime) patch.runtime = d.runtime;
  if (d.studios.length) patch.studios = d.studios.join(", ");
  if (d.collection) patch.collection = d.collection;
  if (d.originalTitle) patch.originalTitle = d.originalTitle;
  if (d.premiered) patch.premiered = d.premiered;
  if (d.logo) {
    const row = await ContentMeta.findByPk(contentId, { attributes: ["artLocked"], transaction });
    if (!lockOf(row).logo) patch.logo = d.logo;
  }
  const writers = d.people.filter((p) => p.kind === "writer").map((p) => p.name);
  if (writers.length) patch.writers = [...new Set(writers)].slice(0, 6).join(", ");
  await ContentMeta.update(patch, { where: { id: contentId }, transaction });
  if (d.people.length) {
    await ContentPerson.destroy({ where: { contentId }, transaction });
    await ContentPerson.bulkCreate(
      d.people.map((p) => ({ contentId, kind: p.kind, name: p.name, role: p.role, sortOrder: p.order, tmdbPersonId: p.tmdbPersonId, photo: p.photo })),
      { transaction },
    );
  }
}

/**
 * Titles matched before details were stored get them from TMDB again by id, newest first,
 * about 8 a second. A title TMDB answered for is marked (detailsCheckedAt) and never asked
 * again, so a restart resumes where it stopped.
 */
async function backfillDetails(): Promise<void> {
  const rows = (await ContentMeta.findAll({
    where: { tmdbId: { [Op.ne]: null }, detailsCheckedAt: null },
    attributes: ["id", "type", "tmdbId", "year", "isRepresentative"],
    raw: true,
  })) as any[];
  rows.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || Number(!!b.isRepresentative) - Number(!!a.isRepresentative));
  let filled = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const meta = await fetchMetaByTmdbId(r.type === "series" ? "tv" : "movie", Number(r.tmdbId));
      if (meta?.details) {
        await withBusyRetry(`[MetaEnrich] details ${r.id}`, () => ContentMeta.sequelize!.transaction((t) => storeDetails(r.id, meta.details, t)));
        filled++;
      }
    } catch (e: any) {
      logger.error(`[MetaEnrich] details ${r.id}: ${e.message}`);
    }
    await sleep(120);
    if ((i + 1) % 2000 === 0) logger.info(`[MetaEnrich] details: ${i + 1}/${rows.length} checked, ${filled} filled`);
  }
  logger.info(`[MetaEnrich] details: ${filled} of ${rows.length} titles filled in`);
}

async function enrichMovies(): Promise<void> {
  const genres = await readGenres("movie");
  const seen = new Set<string>();
  let processed = 0;

  for (const genre of genres) {
    if (!genre.id || genre.id === "*") continue;
    const movies = await xtreamCache.get<any[]>(`vod_streams_${genre.id}`);
    if (!movies) continue;

    for (const m of movies) {
      const id = String(m.stream_id);
      if (seen.has(id)) continue;
      seen.add(id);

      const contentId = `movie_${id}`;
      const existing = await ContentMeta.findByPk(contentId);
      if (existing?.enrichedAt) continue;

      const name = m.name || `Movie_${id}`;
      const year = extractYear(m.year || m.added || "");

      try {
        const resolved = await resolveMeta(
          "movie",
          `tmdb_movie_${id}`,
          name,
          year,
          splitList(m.genres_str),
          splitList(m.country),
          m.stream_icon || null,
          portalPlot(m),
        );
        await upsertContent(contentId, "movie", name, resolved, String(genre.id));
      } catch (e: any) {
        logger.error(`[MetaEnrich] movie ${name}: ${e.message}`);
      }

      processed++;
      if (processed % LOG_EVERY === 0) logger.info(`[MetaEnrich] Movies: processed ${processed}`);
    }
  }
  logger.info(`[MetaEnrich] Movies done — processed ${processed}`);
}

async function enrichSeries(): Promise<void> {
  const genres = await readGenres("series");
  const seen = new Set<number>();
  let processed = 0;

  for (const genre of genres) {
    if (!genre.id || genre.id === "*") continue;
    const seriesList = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
    if (!seriesList) continue;

    for (const s of seriesList) {
      const seriesId = s.series_id as number;
      if (!seriesId || seen.has(seriesId)) continue;
      seen.add(seriesId);

      const contentId = `series_${seriesId}`;
      const existing = await ContentMeta.findByPk(contentId);
      if (existing?.enrichedAt) continue;

      const name = s.name || `Series_${seriesId}`;
      const year = extractYear(s.releaseDate || "");

      try {
        const resolved = await resolveMeta(
          "tv",
          `tmdb_tv_${seriesId}`,
          name,
          year,
          splitList(s.genre),
          splitList(s.country),
          s.cover || null,
          portalPlot(s),
        );
        await upsertContent(contentId, "series", name, resolved, String(genre.id));
      } catch (e: any) {
        logger.error(`[MetaEnrich] series ${name}: ${e.message}`);
      }

      processed++;
      if (processed % LOG_EVERY === 0) logger.info(`[MetaEnrich] Series: processed ${processed}`);
    }
  }
  logger.info(`[MetaEnrich] Series done — processed ${processed}`);
}

// Flags exactly one row per groupKey (distinct base title, e.g. "ABC") as the
// single representative shown in Discover listings — every language/format
// variant of that title ("ABC Tamil", "ABC South Dub", ...) shares a groupKey
// but only the "best" one (TMDB-sourced preferred, then most complete data)
// is the card users see; the rest are reachable via the variants endpoint.
//
// Done as a plain boolean flag recomputed here, rather than a live SQL GROUP
// BY at query time — SQLite's GROUP BY without an aggregate function picks an
// unspecified row per group, which would make listings' "which variant shows"
// silently inconsistent across queries. A precomputed flag is a plain WHERE
// predicate instead, fully compatible with existing pagination/joins/caching.
//
// Two-step raw SQL (not one query) because the inner correlated subquery
// needs to run to completion and be stable before the outer UPDATE reads it —
// combining "reset all" and "pick winners" into one statement isn't possible
// since SQLite has no single-statement UPSERT-across-groups primitive.
export async function recomputeRepresentatives(): Promise<void> {
  const sequelize = ContentMeta.sequelize!;
  // One representative per groupKey: TMDB-sourced first, then has a poster, then most
  // recently enriched (id breaks remaining ties, so the choice is deterministic).
  //
  // Computed once into a temp table, then only rows whose flag is actually wrong are
  // written. The previous version reset and rewrote the flag on every content_meta row
  // and every tag row (~540k rows on the live data), on every startup and after every
  // enrichment run: 21–30 s of writes, each also updating every index containing the
  // flag, even when nothing had changed. Measured on a live copy: 3 s on a typical
  // restart (0 rows written), with the identical selection.
  //
  // The tag tables mirror the flag so facet/browse filtering never needs a join back to
  // content_meta (see ContentGenre.ts for the incident that made this necessary).
  // Runs inside one transaction so the temp table and the updates share a connection.
  await sequelize.transaction(async (transaction) => {
    const q = (sql: string) => sequelize.query(sql, { transaction });
    await q("CREATE TEMP TABLE IF NOT EXISTS `rep_ids` (`id` TEXT PRIMARY KEY) WITHOUT ROWID;");
    await q("DELETE FROM temp.`rep_ids`;");
    await q(`
      INSERT INTO temp.\`rep_ids\` (\`id\`)
      SELECT \`id\` FROM (
        SELECT \`id\`, ROW_NUMBER() OVER (
          PARTITION BY \`groupKey\`
          ORDER BY (\`source\` = 'tmdb') DESC, (\`portalCategoryId\` = 'local') DESC, \`poster\` IS NOT NULL DESC, \`enrichedAt\` DESC, \`id\` ASC
        ) AS rn
        FROM \`content_meta\` WHERE \`groupKey\` IS NOT NULL
      ) WHERE rn = 1;
    `);
    await q("UPDATE `content_meta` SET `isRepresentative` = 1 WHERE `isRepresentative` IS NOT 1 AND `id` IN (SELECT `id` FROM temp.`rep_ids`);");
    await q("UPDATE `content_meta` SET `isRepresentative` = 0 WHERE `isRepresentative` IS NOT 0 AND `id` NOT IN (SELECT `id` FROM temp.`rep_ids`);");
    for (const table of ["content_genres", "content_countries", "content_themes"]) {
      await q(`UPDATE \`${table}\` SET \`isRepresentative\` = 1 WHERE \`isRepresentative\` IS NOT 1 AND \`contentId\` IN (SELECT \`id\` FROM temp.\`rep_ids\`);`);
      await q(`UPDATE \`${table}\` SET \`isRepresentative\` = 0 WHERE \`isRepresentative\` IS NOT 0 AND \`contentId\` NOT IN (SELECT \`id\` FROM temp.\`rep_ids\`);`);
    }
    await q("DELETE FROM temp.`rep_ids`;");
  });
}

// One-time repair for rows enriched before portalCategoryId existed —
// enrichMovies/enrichSeries skip any row with enrichedAt already set, so
// those never pass back through upsertContent() to get it filled in.
// Same "first cached category list containing this id" resolution as
// enrichment itself uses, just done once here instead of per-request (which
// is what routes/stalkerV2/movies.ts and series.ts used to do at click time —
// unreliable there since a stale/duplicate cache entry could win over the
// real current category, e.g. a Discover-opened title playing back with the
// wrong category and showing wrong metadata).
async function backfillPortalCategoryIds(): Promise<void> {
  const missingMovies = await ContentMeta.findAll({
    where: { type: "movie", portalCategoryId: null as any },
    attributes: ["id"],
    raw: true,
  }) as unknown as { id: string }[];
  const missingSeries = await ContentMeta.findAll({
    where: { type: "series", portalCategoryId: null as any },
    attributes: ["id"],
    raw: true,
  }) as unknown as { id: string }[];
  if (missingMovies.length === 0 && missingSeries.length === 0) return;

  logger.info(`[MetaEnrich] Backfilling portalCategoryId for ${missingMovies.length} movies, ${missingSeries.length} series...`);

  if (missingMovies.length > 0) {
    const wanted = new Set(missingMovies.map((r) => r.id.replace(/^movie_/, "")));
    const found = new Map<string, string>();
    const genres = await readGenres("movie");
    for (const genre of genres) {
      if (!genre.id || genre.id === "*" || wanted.size === found.size) continue;
      const movies = await xtreamCache.get<any[]>(`vod_streams_${genre.id}`);
      if (!movies) continue;
      for (const m of movies) {
        const id = String(m.stream_id);
        if (wanted.has(id) && !found.has(id)) found.set(id, String(genre.id));
      }
    }
    for (const [id, categoryId] of found) {
      await ContentMeta.update({ portalCategoryId: categoryId }, { where: { id: `movie_${id}` } });
    }
  }

  if (missingSeries.length > 0) {
    const wanted = new Set(missingSeries.map((r) => r.id.replace(/^series_/, "")));
    const found = new Map<string, string>();
    const genres = await readGenres("series");
    for (const genre of genres) {
      if (!genre.id || genre.id === "*" || wanted.size === found.size) continue;
      const seriesList = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
      if (!seriesList) continue;
      for (const s of seriesList) {
        const id = String(s.series_id);
        if (wanted.has(id) && !found.has(id)) found.set(id, String(genre.id));
      }
    }
    for (const [id, categoryId] of found) {
      await ContentMeta.update({ portalCategoryId: categoryId }, { where: { id: `series_${id}` } });
    }
  }

  logger.info("[MetaEnrich] portalCategoryId backfill complete.");
}

// Targeted refresh for rows enriched before the images-aware tmdb.ts existed
// (or that just never turned up a qualifying backdrop last time) — unlike
// enrichMovies/enrichSeries, which skip any row that already has enrichedAt
// set, this is the one pass that revisits already-enriched rows, and it only
// ever touches backdrop/backdropHd. Uses the tmdbId already stored on the row
// (source: "tmdb") to fetch straight by id — no search step, no risk of a
// re-search matching a different title than what's already there — and only
// requests images (via fetchMetaByTmdbId -> fetchDetail's append_to_response)
// rather than re-deriving genres/countries/themes, which this pass has no
// reason to touch. Same THROTTLE_MS pace as the rest of enrichment, so this
// is expected to take a while over a large catalog — it's the same
// manual-trigger-only, run-when-convenient tradeoff as everything else here.
async function backfillBackdrops(): Promise<void> {
  // backdropCheckedAt (not backdropHd) is the "already handled" signal — a
  // null backdropHd alone can't tell "never checked" apart from "checked,
  // TMDB genuinely has no HD backdrop for this title," which used to make
  // every run re-fetch the same permanently-backdrop-less rows forever.
  const missing = (await ContentMeta.findAll({
    where: { backdropCheckedAt: null as any, source: "tmdb", artLocked: null as any },
    attributes: ["id", "type", "tmdbId"],
    raw: true,
  })) as unknown as { id: string; type: ContentType; tmdbId: number | null }[];
  const candidates = missing.filter((r) => r.tmdbId);
  if (candidates.length === 0) return;

  logger.info(`[MetaEnrich] Refreshing HD backdrop for ${candidates.length} rows...`);
  let updated = 0;
  for (const row of candidates) {
    try {
      const kind = row.type === "movie" ? "movie" : "tv";
      const meta = await fetchMetaByTmdbId(kind, row.tmdbId!);
      await sleep(THROTTLE_MS);
      // No result at all (API error/transient failure) is left unchecked so a
      // later run retries it — only a successful fetch (whether or not it
      // actually has a backdrop) counts as "checked" and stops future retries.
      if (!meta) continue;
      const updates: any = { backdropCheckedAt: new Date() };
      if (meta.backdrop || meta.backdropHd) {
        updates.backdrop = meta.backdrop || null;
        updates.backdropHd = meta.backdropHd || null;
        updated++;
      }
      await ContentMeta.update(updates, { where: { id: row.id } });
    } catch (e: any) {
      logger.error(`[MetaEnrich] backdrop refresh failed for ${row.id}: ${e.message}`);
    }
  }
  logger.info(`[MetaEnrich] HD backdrop refresh complete — updated ${updated}/${candidates.length} rows.`);
}

// Called at click-time (movies.ts/series.ts routes) when a direct
// movieId/seriesId lookup against the live portal comes back empty — the
// portal no longer has this item, so its Discover/ContentMeta row (and the
// tag rows that made it show up in genre/country/theme filters) is now
// pointing at dead content. Deleting it here, on the failed click itself,
// means the item stops appearing in Discover/search on the very next fetch
// instead of only being cleaned up on the next full enrichContentMeta() run
// (manual-trigger only, per THROTTLE_MS above — could be days away).
// `portalCategoryId` is the category the caller had just looked this item up
// under (falls back to the row's own stored one) — used to also strip the
// item out of that category's warmed vod_streams_*/series_list_* list cache,
// which is what movie search/browsing actually reads from (see movies.ts'
// "*"-category branch). Without this, the item would disappear from Discover
// but keep surfacing in regular search/browse until that list cache happens
// to get refreshed by the normal warm cycle.
export async function pruneContentMeta(contentId: string, portalCategoryId?: string): Promise<void> {
  const existing = await ContentMeta.findByPk(contentId);
  if (!existing && !portalCategoryId) return;

  const groupKey = existing?.groupKey;
  const wasRepresentative = existing?.isRepresentative;
  const categoryId = portalCategoryId || existing?.portalCategoryId;

  // UserProgress.mediaId uses this same movie_{id}/series_{id} shape (see
  // client's saveUserProgress), so any Continue Watching entry for content
  // that's been removed from the portal was otherwise left permanently
  // orphaned — pointing at a title that no longer exists anywhere, with
  // nothing to ever clean it up. Unconditional on `existing` (runs even if
  // ContentMeta was already pruned by an earlier version of this function,
  // before this cleanup existed) so it also retroactively catches those.
  try {
    const deleted = await UserProgress.destroy({ where: { mediaId: contentId } });
    if (deleted > 0) {
      logger.info(`[MetaEnrich] Removed ${deleted} orphaned UserProgress row(s) for pruned content ${contentId}`);
    }
  } catch (e: any) {
    logger.error(`[MetaEnrich] Failed to clean up UserProgress for pruned content ${contentId}: ${e.message}`);
  }

  if (existing) {
    await ContentGenre.destroy({ where: { contentId } });
    await ContentCountry.destroy({ where: { contentId } });
    await ContentTheme.destroy({ where: { contentId } });
    await existing.destroy();
  }

  if (categoryId) {
    const isMovie = contentId.startsWith("movie_");
    const rawId = contentId.replace(/^(movie|series)_/, "");
    const listCacheKey = isMovie ? `vod_streams_${categoryId}` : `series_list_${categoryId}`;
    const idField = isMovie ? "stream_id" : "series_id";
    const list = await xtreamCache.get<any[]>(listCacheKey);
    if (list) {
      const filtered = list.filter((item: any) => String(item[idField]) !== rawId);
      if (filtered.length !== list.length) {
        await xtreamCache.set(listCacheKey, filtered);
      }
    }
  }

  // This row was the one shown for its groupKey (e.g. "ABC") — if any other
  // language/format variant of the same title still exists, promote it so
  // the title doesn't just vanish from Discover if a still-valid variant
  // ("ABC Tamil") is sitting right there. Same tie-break preference as
  // recomputeRepresentatives() (tmdb-sourced > has a poster > most recently
  // enriched), just scoped to this one groupKey instead of a full-table scan.
  if (wasRepresentative && groupKey) {
    const siblings = (await ContentMeta.findAll({ where: { groupKey } })) as any[];
    if (siblings.length > 0) {
      const best = siblings.reduce((a: any, b: any) => {
        const score = (r: any) => (r.source === "tmdb" ? 2 : 0) + (r.poster ? 1 : 0);
        const [sa, sb] = [score(a), score(b)];
        if (sa !== sb) return sa > sb ? a : b;
        return new Date(a.enrichedAt) > new Date(b.enrichedAt) ? a : b;
      });
      await best.update({ isRepresentative: true });
      for (const Model of [ContentGenre, ContentCountry, ContentTheme]) {
        await Model.update({ isRepresentative: true }, { where: { contentId: best.id } });
      }
    }
  }

  clearDiscoverCache();
  logger.info(`[MetaEnrich] Pruned stale content ${contentId} (no longer present on portal)`);
}

// warmVodCache/warmSeriesCache (services/xtreamCache.ts) use fetchUntilKnown,
// which stops paginating the instant it hits an already-cached item — cheap
// (usually just page 1), but purely additive: it can only ever discover NEW
// items, never notice one that's disappeared from the provider. Otherwise-
// orphaned content only ever got cleaned up reactively, one item at a time,
// when a user happened to click something the portal had since 404'd on
// (pruneContentMeta's caller in movies.ts/series.ts) — anything nobody
// clicked again just sat there forever.
//
// catchupScan() (services/xtreamCache.ts) already solves the detection side
// efficiently — it compares the portal's own reported total_items against
// the local count per category, doing a cheap bounded incremental scan when
// the portal has more, and only paying for a full-page scan when the total
// actually dropped (i.e. something was genuinely removed). It's normally
// manual-trigger-only (POST /api/v2/catchup-scan) and scans every category.
// This wraps it instead of reimplementing detection: passes `onRemoved` so
// every id catchupScan confirms gone also gets pruned here (ContentMeta +
// tags + UserProgress + list-cache — catchupScan itself only touches the
// list-cache), and scopes it to a small rotating slice of categories
// (SWEEP_CATEGORIES_PER_RUN) via `genreIds` so a full pass over the whole
// catalog completes gradually over many days/weeks — with a `throttleMs`
// pace on top — rather than a full-catalog re-fetch on every run. Content
// removal isn't time-sensitive the way new content is, so a slow rolling
// sweep is the right tradeoff.
const SWEEP_CATEGORIES_PER_RUN = 5;
const SWEEP_CURSOR_KEY = "content_sweep_cursor";

export async function sweepStaleContent(): Promise<void> {
  const movieGenres = await readGenres("movie");
  const seriesGenres = await readGenres("series");
  const genreIds = new Set<string>();
  for (const g of [...movieGenres, ...seriesGenres]) {
    if (g.id && g.id !== "*") genreIds.add(g.id);
  }
  const allIds = Array.from(genreIds).sort();
  if (allIds.length === 0) return;

  const cursorRow = await SystemConfig.findByPk(SWEEP_CURSOR_KEY);
  const startIdx = (Number(cursorRow?.value) || 0) % allIds.length;
  const sliceSize = Math.min(SWEEP_CATEGORIES_PER_RUN, allIds.length);
  const slice = Array.from({ length: sliceSize }, (_, i) => allIds[(startIdx + i) % allIds.length]);

  let prunedCount = 0;
  const didRun = await catchupScan({
    genreIds: slice,
    throttleMs: THROTTLE_MS,
    onRemoved: async (contentId, categoryId) => {
      await pruneContentMeta(contentId, categoryId);
      prunedCount++;
    },
  });

  if (!didRun) {
    // Another catchupScan (manual /api/v2/catchup-scan or an overlapping
    // previous sweep) was already in progress — this slice was never
    // actually checked. Don't advance the cursor, or these categories would
    // get silently skipped for a full rotation cycle instead of just retried
    // on the next run.
    logger.info(`[ContentSweep] Skipped — another catchup scan was already in progress. Will retry the same ${slice.length} categor${slice.length === 1 ? "y" : "ies"} next run.`);
    return;
  }

  await SystemConfig.upsert({ key: SWEEP_CURSOR_KEY, value: (startIdx + sliceSize) % allIds.length });
  logger.info(`[ContentSweep] Checked ${slice.length} categor${slice.length === 1 ? "y" : "ies"} via catchupScan, pruned ${prunedCount} removed item(s).`);
}

let isEnriching = false;

// backfillBackdrops has no way to distinguish "not tried yet" from "tried,
// TMDB has no backdrop" — both leave backdropHd null — so it would re-fetch
// the same permanently-backdrop-less rows from TMDB on every automatic run
// forever. Keep it out of the automatic startup/24h path; only run it when
// explicitly requested (manual admin trigger).
// ---- one-time catalog fix-ups, by generation --------------------------------------------
// Each generation runs once per database (SystemConfig remembers the last one done), after
// the regular enrichment pass, so a server upgrade repairs existing rows without a manual
// re-enrichment of the whole catalog.
const FIXUP_KEY = "meta_fixup_generation";
const FIXUP_GENERATION = 3;

// Each step is remembered on its own as soon as it finishes (a restart mid-way never
// repeats a finished step). The regroup is cheap and runs first, with representatives and
// the Discover index refreshed right after, so a bad grouping left in the database (the
// TMDB-id-only regroup of 2026-10-20 hid ~8,000 titles) is repaired within minutes of
// startup instead of after the slow TMDB passes.
const FIXUP_STEPS_KEY = "meta_fixup_steps";

async function runFixups(): Promise<void> {
  const legacy = Number((await SystemConfig.findByPk(FIXUP_KEY))?.value ?? 0);
  const row = await SystemConfig.findByPk(FIXUP_STEPS_KEY);
  const done = new Set<string>(Array.isArray(row?.value) ? row!.value : []);
  // Servers that recorded the earlier single generation number: keep what it had finished.
  if (legacy >= 1) done.add("retry-unmatched");
  if (legacy >= 2) done.add("reclean-channels");
  if (legacy >= 3) done.add("regroup-v1");
  const step = async (name: string, run: () => Promise<void>) => {
    if (done.has(name)) return;
    logger.info(`[MetaEnrich] fix-up step: ${name}`);
    await run();
    done.add(name);
    await SystemConfig.upsert({ key: FIXUP_STEPS_KEY, value: [...done] });
  };
  await step("regroup-v1", async () => {
    await regroupAll();
    await recomputeRepresentatives();
    clearDiscoverCache();
  });
  // "- Turkish" / "Turkish Drama :" became tags (titleClean.ts): regroup and rename those.
  await step("regroup-turkish", async () => {
    await regroupAll(/turkish/i);
    await recomputeRepresentatives();
    clearDiscoverCache();
  });
  // Streaming-service prefixes ("Zee5 Originals : X", "Sony Liv : X", "Hotstar : X") joined
  // the channel list: re-clean and regroup those few rows.
  await step("reclean-services", async () => {
    await regroupAll(/zee\s?5|sony\s?liv|hotstar|jio\s?cinema|voot|^\s*aha\s*:/i);
    await recomputeRepresentatives();
    clearDiscoverCache();
  });
  // More channels and their longer spellings (Surya TV, Flowers TV, "Star Suvarna Kannada",
  // "Hum Tv Drama", ...) and the label prefixes ("Urdu Tv Show :", "Web Series :"): every row
  // with a channel is re-cleaned by regroupAll; the labels are named here.
  await step("reclean-channels-2", async () => {
    await regroupAll(/^\s*(urdu\s+tv|urdu\s+show|web\s+series)\s*:/i);
    await recomputeRepresentatives();
    clearDiscoverCache();
  });
  // The first run read only object-shaped meta and sealed nothing: stored meta is JSON text.
  await step("seal-progress-links", async () => {});
  await step("seal-progress-links-2", sealProgressLinks);
  await step("backfill-credits", backfillCreditsAndOverview);
  await step("fix-year-mismatches", fixYearMismatches);
  await step("backfill-ratings-creators", backfillRatingsAndCreators);
  await step("backfill-details", backfillDetails);
  // Second pass: titles the first pass lost to "database is locked" (before writes retried).
  await step("backfill-details-2", backfillDetails);
  await step("retry-unmatched", retryUnmatched);
  await step("reclean-channels", recleanChannelNames);
  // The TMDB passes write rows through upsertContent (groupKeyFor), so their groups are
  // already right; recomputeRepresentatives at the end of enrichContentMeta picks again.
}

/**
 * Titles whose own year ("Wonder Woman 1973") is more than a year from the year of the TMDB
 * entry they were matched to (316 on the live catalog, 2026-10-20): searched again with the
 * year rule (tmdb.ts pickResult). They get the right entry or, failing that, the portal's own
 * poster, genres and plot, with the wrong cast/description cleared.
 */
async function fixYearMismatches(): Promise<void> {
  const rows = (await ContentMeta.findAll({
    where: { tmdbId: { [Op.ne]: null } },
    attributes: ["id", "type", "name", "year", "portalCategoryId"],
    raw: true,
  })) as any[];
  const suspect = rows.filter((r) => {
    const ty = titleYearOf(r.name);
    return ty !== null && /^\d{4}$/.test(String(r.year || "")) && Math.abs(Number(r.year) - ty) > 1;
  });
  if (suspect.length === 0) return;
  // The portal's own data for the fallback (the stored poster/genres are the wrong title's).
  const portal = new Map<string, any>();
  for (const [kind, prefix, idKey] of [["movie", "vod_streams_", "stream_id"], ["series", "series_list_", "series_id"]] as const) {
    const genres = await readGenres(kind === "movie" ? "movie" : "series");
    for (const g of genres) {
      if (!g.id || g.id === "*") continue;
      for (const item of (await xtreamCache.get<any[]>(`${prefix}${g.id}`)) ?? []) portal.set(`${kind}_${item[idKey]}`, item);
    }
  }
  // The match stands when the portal's own year field agrees with TMDB: then the number in
  // the name is what is off (part of the title, an upload year...) — 212 of 313 on the live
  // catalog, e.g. "Streisand: Live in Concert 2006" (portal and TMDB: 2009). Only titles
  // whose name AND portal year both disagree ("Karz 2002" matched to the 1980 Karz) are
  // searched again.
  const portalYear = (item: any): number | null => {
    const m = /(?:19|20)\d{2}/.exec(String(item?.year ?? item?.releaseDate ?? item?.releasedate ?? ""));
    return m ? Number(m[0]) : null;
  };
  const wrong = suspect.filter((r) => {
    const py = portalYear(portal.get(r.id));
    return py === null || Math.abs(py - Number(r.year)) > 1;
  });
  let rematched = 0, cleared = 0;
  for (const row of wrong) {
    const kind = row.type === "movie" ? "movie" : "tv";
    const portalId = String(row.id).replace(/^(movie|series)_/, "");
    const cacheKey = kind === "movie" ? `tmdb_movie_${portalId}` : `tmdb_tv_${portalId}`;
    const item = portal.get(row.id);
    try {
      await xtreamCache.delete(cacheKey);
      await xtreamCache.delete(`tmdb_web_${row.type === "movie" ? "movie" : "series"}_${portalId}`);
      const resolved = await resolveMeta(
        kind,
        cacheKey,
        row.name,
        String(titleYearOf(row.name) ?? ""),
        splitList(item?.genres_str ?? item?.genre),
        splitList(item?.country),
        item?.stream_icon || item?.cover || null,
        portalPlot(item),
      );
      if (resolved.tmdbId) rematched++; else cleared++;
      await upsertContent(row.id, row.type, row.name, resolved, row.portalCategoryId || "");
    } catch (e: any) {
      logger.error(`[MetaEnrich] year fix ${row.name}: ${e.message}`);
    }
  }
  logger.info(`[MetaEnrich] year mismatches: ${suspect.length} found, ${suspect.length - wrong.length} kept (portal year agrees with TMDB), ${wrong.length} re-checked: ${rematched} matched the right entry, ${cleared} back to portal data`);
}

/**
 * Watch-progress records that stored a raw upstream stream link (23 on the live server,
 * 2026-10-20: CDN links a browser had received for an episode): sealed in place, so
 * resuming still works and nothing readable is left (infra/sealedCmd.ts).
 */
export async function sealProgressLinks(): Promise<void> {
  const rows = await UserProgress.findAll();
  let sealed = 0;
  for (const row of rows) {
    // Comes back as JSON text on this table; parsed here, written back as an object (the
    // column stringifies it once: writing the text back would encode it twice).
    const stored: any = row.meta;
    let meta: any = stored;
    if (typeof stored === "string") {
      try { meta = JSON.parse(stored); } catch { continue; }
    }
    if (!meta || typeof meta !== "object" || !isUpstreamLink(meta.cmd)) continue;
    const next = { ...meta, cmd: sealCmd(meta.cmd) };
    row.meta = next;
    row.changed("meta", true);
    await row.save();
    sealed++;
  }
  logger.info(`[MetaEnrich] progress records: sealed the stream link in ${sealed} of ${rows.length}`);
}

/**
 * Ratings and IMDb ids were not stored, and series had no creators (only a "Director" credit was read,
 * which a series rarely has: 16% of series had one, 2026-10-20). Every TMDB-matched row
 * without a rating (or a series without creators) has its TMDB details fetched again by its
 * id; only the rating, creators, and empty cast / overview are written. About 100k rows, a few
 * hours in the background; a restart resumes with the rows still missing.
 */
async function backfillRatingsAndCreators(): Promise<void> {
  const rows = (await ContentMeta.findAll({
    where: { tmdbId: { [Op.ne]: null } },
    attributes: ["id", "type", "tmdbId", "cast", "director", "overview", "rating", "imdbId", "year", "isRepresentative", "ratingsCheckedAt"],
    raw: true,
  })) as any[];
  // Newest titles first (what people open first), the card shown in Discover before its
  // other versions. A title TMDB already answered for (ratingsCheckedAt) is not asked again
  // after a restart, even when TMDB had no rating or IMDb id for it.
  const todo = rows
    .filter((r) => !r.ratingsCheckedAt && (r.rating == null || !r.imdbId || (r.type === "series" && !r.director)))
    .sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || Number(!!b.isRepresentative) - Number(!!a.isRepresentative));
  let filled = 0;
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i];
    try {
      const meta = await fetchMetaByTmdbId(r.type === "series" ? "tv" : "movie", Number(r.tmdbId));
      if (meta) {
        // Recorded only when TMDB answered: a failed request is tried again next run.
        const patch: Record<string, string | number | Date> = { ratingsCheckedAt: new Date() };
        if (meta.rating != null) { patch.rating = meta.rating; patch.ratingCount = meta.ratingCount ?? 0; }
        if (meta.imdbId) patch.imdbId = meta.imdbId;
        if (r.type === "series" && !r.director && meta.director) patch.director = meta.director;
        if (!r.cast && meta.cast) patch.cast = meta.cast;
        if (!r.overview && meta.overview) patch.overview = meta.overview;
        if (Object.keys(patch).length > 1) filled++;
        await ContentMeta.update(patch, { where: { id: r.id } });
      }
    } catch (e: any) {
      logger.error(`[MetaEnrich] creators ${r.id}: ${e.message}`);
    }
    // TMDB allows ~40 requests/s; 8/s leaves room for the app's own lookups.
    await sleep(120);
    if ((i + 1) % 2000 === 0) logger.info(`[MetaEnrich] ratings/creators: ${i + 1}/${todo.length} checked, ${filled} filled`);
  }
  logger.info(`[MetaEnrich] ratings/creators: ${filled} of ${todo.length} titles filled in`);
}

/**
 * Series TMDB does not know get a description, cast and creators from TVmaze when it has the
 * show under the exact same title (content/tvmaze.ts). Runs after every enrichment pass; a
 * series is looked up once (cache key tvmaze_series_<id>), and only empty fields are filled.
 */
async function enrichFromTvmaze(): Promise<void> {
  if (!setting<boolean>("tvmazeEnabled")) return;
  const rows = (await ContentMeta.findAll({
    where: { type: "series", tmdbId: null, isRepresentative: true },
    attributes: ["id", "name", "trimmedName", "year", "cast", "director", "overview", "poster", "rating"],
    raw: true,
  })) as any[];
  // Newest first, like the TMDB backfill.
  const todo = rows.filter((r) => !r.overview || !r.cast).sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
  let looked = 0, matched = 0;
  for (const r of todo) {
    const key = `tvmaze_series_${r.id}`;
    if (await xtreamCache.get<any>(key)) continue;
    looked++;
    try {
      const show = await findTvmazeShow(stripReleaseNoise(r.name) || r.trimmedName || r.name, r.year, channelOf(r.name));
      await xtreamCache.set(key, show ? { id: show.id } : { _not_found: true });
      if (!show) continue;
      const patch: Record<string, string | number> = {};
      if (r.rating == null && show.rating != null) patch.rating = show.rating;
      if (!r.overview && show.summary) patch.overview = show.summary;
      if (!r.cast && show.cast) patch.cast = show.cast;
      if (!r.director && show.creators) patch.director = show.creators;
      if (!r.poster && show.poster) patch.poster = show.poster;
      if (Object.keys(patch).length) { await ContentMeta.update(patch, { where: { id: r.id } }); matched++; }
    } catch (e: any) {
      logger.error(`[TVmaze] ${r.name}: ${e.message}`);
    }
    if (looked % 500 === 0) logger.info(`[TVmaze] ${looked} looked up, ${matched} filled`);
  }
  if (looked) logger.info(`[TVmaze] done: ${looked} series looked up, ${matched} filled in (of ${todo.length} without description or cast)`);
}

/**
 * Rows saved before cast/director/overview were stored (July) never got them, though the
 * TMDB data cached on the server has them (55k casts, 63k descriptions measured on the live
 * catalog, 2026-10-20). Copied from that cache, nothing fetched; for titles TMDB does not
 * know, the description falls back to the portal's own plot. Only empty fields are filled.
 */
export async function backfillCreditsAndOverview(): Promise<void> {
  const rows = (await ContentMeta.findAll({
    attributes: ["id", "type", "tmdbId", "cast", "director", "overview"],
    raw: true,
  })) as any[];
  const needs = rows.filter((r) => !r.overview || (r.tmdbId && (!r.cast || !r.director)));
  // Portal plots for the unmatched ones, from the warmed category lists.
  const plots = new Map<string, string>();
  if (needs.some((r) => !r.tmdbId)) {
    for (const [kind, prefix, idKey] of [["movie", "vod_streams_", "stream_id"], ["series", "series_list_", "series_id"]] as const) {
      const genres = await readGenres(kind === "movie" ? "movie" : "series");
      for (const g of genres) {
        if (!g.id || g.id === "*") continue;
        for (const item of (await xtreamCache.get<any[]>(`${prefix}${g.id}`)) ?? []) {
          const plot = portalPlot(item);
          if (plot) plots.set(`${kind}_${item[idKey]}`, plot);
        }
      }
    }
  }
  const BATCH = 500;
  let changed = 0;
  for (let i = 0; i < needs.length; i += BATCH) {
    const slice = needs.slice(i, i + BATCH);
    const cached = await xtreamCache.getMany<any>(
      slice.filter((r) => r.tmdbId).map((r) => `${r.type === "movie" ? "tmdb_movie_" : "tmdb_tv_"}${String(r.id).replace(/^(movie|series)_/, "")}`),
    );
    await ContentMeta.sequelize!.transaction(async (transaction) => {
      for (const r of slice) {
        const key = `${r.type === "movie" ? "tmdb_movie_" : "tmdb_tv_"}${String(r.id).replace(/^(movie|series)_/, "")}`;
        const meta = r.tmdbId ? cached.get(key) : undefined;
        const patch: Record<string, string> = {};
        if (!r.cast && meta?.cast) patch.cast = meta.cast;
        if (!r.director && meta?.director) patch.director = meta.director;
        const overview = (meta && !meta._not_found && meta.overview) || plots.get(r.id);
        if (!r.overview && overview) patch.overview = overview;
        if (Object.keys(patch).length === 0) continue;
        await ContentMeta.update(patch, { where: { id: r.id }, transaction });
        changed++;
      }
    });
  }
  logger.info(`[MetaEnrich] credits/descriptions filled in for ${changed} of ${needs.length} rows that lacked them`);
}

/**
 * Generation 3: every row's group and cleaned name recomputed with the current rules
 * (groupKeyFor, stripReleaseNoise), in batched transactions. Representatives are picked
 * again right after (enrichContentMeta), so Discover shows one card per real title.
 */
async function regroupAll(alsoRename?: RegExp): Promise<void> {
  const rows = (await ContentMeta.findAll({
    attributes: ["id", "type", "name", "year", "tmdbId", "groupKey", "trimmedName"],
    raw: true,
  })) as any[];
  // The cleaned name is only rewritten where today's rules are meant to change it: a title
  // with a channel in front, or a name the old prefix pattern had cut short ("Wars" ->
  // "Star Wars"). Other rows keep theirs, so no older cleaning rule is applied anew.
  const changes = rows
    .map((r) => {
      const fresh = stripReleaseNoise(r.name);
      const old = r.trimmedName || "";
      const trimmedName = channelOf(r.name) || fresh.length > old.length || alsoRename?.test(r.name) ? fresh : old;
      return { id: r.id, groupKey: groupKeyFor(r.type, r.name, r.year, r.tmdbId), trimmedName, old: r };
    })
    .filter((c) => c.groupKey !== c.old.groupKey || c.trimmedName !== (c.old.trimmedName || ""));
  const BATCH = 500;
  for (let i = 0; i < changes.length; i += BATCH) {
    await ContentMeta.sequelize!.transaction(async (transaction) => {
      for (const c of changes.slice(i, i + BATCH)) {
        await ContentMeta.update({ groupKey: c.groupKey, trimmedName: c.trimmedName }, { where: { id: c.id }, transaction });
      }
    });
  }
  logger.info(`[MetaEnrich] regrouped: ${changes.length} of ${rows.length} rows got a new group or cleaned name`);
}

/**
 * Generation 1: a second TMDB pass over titles that never matched, now that tmdbQueries()
 * also tries the name without a glued-on year, without a ": Season N to current" tail and
 * the part before a colon. Only rows where that produces a query the old search never
 * sent are retried, at the usual throttle, so this is minutes rather than hours.
 */
async function retryUnmatched(): Promise<void> {
  const rows = (await ContentMeta.findAll({
    where: { tmdbId: null },
    attributes: ["id", "type", "name", "year", "poster", "portalCategoryId"],
    raw: true,
  })) as any[];
  let tried = 0;
  let matched = 0;
  for (const row of rows) {
    const kind = row.type === "movie" ? "movie" : "tv";
    const old = stripReleaseNoise(row.name).toLowerCase();
    if (!tmdbQueries(row.name, row.year || undefined).some((q) => q.query.toLowerCase() !== old)) continue;
    const portalId = String(row.id).replace(/^(movie|series)_/, "");
    const cacheKey = kind === "movie" ? `tmdb_movie_${portalId}` : `tmdb_tv_${portalId}`;
    try {
      await xtreamCache.delete(cacheKey);
      const [genres, countries] = await Promise.all([
        ContentGenre.findAll({ where: { contentId: row.id }, attributes: ["value"], raw: true }),
        ContentCountry.findAll({ where: { contentId: row.id }, attributes: ["value"], raw: true }),
      ]);
      const resolved = await resolveMeta(
        kind,
        cacheKey,
        row.name,
        row.year || "",
        (genres as any[]).map((g) => g.value).filter((v) => v !== UNCATEGORIZED_GENRE),
        (countries as any[]).map((c) => c.value),
        row.poster || null,
      );
      tried++;
      if (resolved.tmdbId) {
        matched++;
        await upsertContent(row.id, row.type, row.name, resolved, row.portalCategoryId || "");
      }
    } catch (e: any) {
      logger.error(`[MetaEnrich] retry ${row.name}: ${e.message}`);
    }
    if (tried % 200 === 0 && tried > 0) logger.info(`[MetaEnrich] retry: ${tried} tried, ${matched} matched`);
  }
  logger.info(`[MetaEnrich] retry of unmatched titles done: ${tried} tried, ${matched} newly matched (of ${rows.length} unmatched)`);
}

/**
 * Generation 2: names with a channel in front ("Zee5 : Manemagalu") get their cleaned name
 * and, for unmatched rows, their group recomputed without it, and are searched on TMDB
 * again by the bare title.
 */
async function recleanChannelNames(): Promise<void> {
  const rows = (await ContentMeta.findAll({
    attributes: ["id", "type", "name", "year", "tmdbId", "poster", "portalCategoryId", "trimmedName"],
    raw: true,
  })) as any[];
  let recleaned = 0;
  let matched = 0;
  for (const row of rows) {
    const trimmed = stripReleaseNoise(row.name);
    const hasChannel = !!channelOf(row.name);
    if (trimmed === row.trimmedName && !hasChannel) continue;
    recleaned++;
    // Matched rows, and unmatched ones without a channel (the old pattern had mangled
    // "Star Wars ..." / "Colors of Love"): only the cleaned name and the name-based group.
    if (row.tmdbId || !hasChannel) {
      await ContentMeta.update(
        row.tmdbId ? { trimmedName: trimmed } : { trimmedName: trimmed, groupKey: groupKeyFor(row.type, row.name, row.year, null) },
        { where: { id: row.id } },
      );
      continue;
    }
    const kind = row.type === "movie" ? "movie" : "tv";
    const portalId = String(row.id).replace(/^(movie|series)_/, "");
    const cacheKey = kind === "movie" ? `tmdb_movie_${portalId}` : `tmdb_tv_${portalId}`;
    try {
      await xtreamCache.delete(cacheKey);
      const [genres, countries] = await Promise.all([
        ContentGenre.findAll({ where: { contentId: row.id }, attributes: ["value"], raw: true }),
        ContentCountry.findAll({ where: { contentId: row.id }, attributes: ["value"], raw: true }),
      ]);
      const resolved = await resolveMeta(
        kind, cacheKey, row.name, row.year || "",
        (genres as any[]).map((g) => g.value).filter((v) => v !== UNCATEGORIZED_GENRE),
        (countries as any[]).map((c) => c.value),
        row.poster || null,
      );
      if (resolved.tmdbId) matched++;
      // Also rewrites trimmedName and groupKey from the new cleaning.
      await upsertContent(row.id, row.type, row.name, resolved, row.portalCategoryId || "");
    } catch (e: any) {
      logger.error(`[MetaEnrich] reclean ${row.name}: ${e.message}`);
    }
  }
  logger.info(`[MetaEnrich] names re-cleaned: ${recleaned} rows, ${matched} channel titles newly matched on TMDB`);
}

export async function enrichContentMeta(options: { includeBackdropBackfill?: boolean } = {}): Promise<void> {
  if (isEnriching) {
    logger.warn("[MetaEnrich] enrichment already in progress — skipping this request");
    return;
  }
  isEnriching = true;
  try {
    // Fix-ups first: the regroup step repairs Discover within minutes of startup.
    await runFixups();
    await enrichFromTvmaze();
    await syncImdbRatings();
    await enrichFromOmdb();
    await enrichMovies();
    await enrichSeries();
    await backfillPortalCategoryIds();
    if (options.includeBackdropBackfill) {
      await backfillBackdrops();
    }
    await recomputeRepresentatives();
    clearDiscoverCache();
  } finally {
    isEnriching = false;
  }
}
