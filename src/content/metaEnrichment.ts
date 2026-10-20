import { splitChannel } from "@/content/channelNames";
import { Transaction } from "sequelize";
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
import { tmdbQueries } from "@/content/tmdb";

/**
 * The key language/format variants of one title share. A TMDB match groups by TMDB id,
 * so "Kim's Convenience" and "Kim's Convenience 2016" (whose name alone never produced
 * the same key) are one title with two versions; unmatched rows fall back to the
 * cleaned name plus year.
 */
export function groupKeyFor(type: ContentType, name: string, year: string | null | undefined, tmdbId?: number | null): string {
  return tmdbId ? `${type}:tmdb:${tmdbId}` : `${type}:${normalizeTitleKey(name)}:${year || ""}`;
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
  const isLegacyShape = tmdb && !("_not_found" in tmdb) && (!("originalLanguage" in tmdb) || !("releaseYear" in tmdb));
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
    }, { transaction });
    await replaceTags(ContentGenre, contentId, resolved.genres, transaction);
    await replaceTags(ContentCountry, contentId, resolved.countries, transaction);
    await replaceTags(ContentTheme, contentId, resolved.themes, transaction);
  });
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
          ORDER BY (\`source\` = 'tmdb') DESC, \`poster\` IS NOT NULL DESC, \`enrichedAt\` DESC, \`id\` ASC
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
    where: { backdropCheckedAt: null as any, source: "tmdb" },
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
const FIXUP_GENERATION = 2;

async function runFixups(): Promise<void> {
  const row = await SystemConfig.findByPk(FIXUP_KEY);
  const done = Number(row?.value ?? 0);
  if (done >= FIXUP_GENERATION) return;
  logger.info(`[MetaEnrich] running catalog fix-ups ${done + 1}..${FIXUP_GENERATION}`);
  if (done < 1) {
    await regroupByTmdbId();
    await retryUnmatched();
  }
  if (done < 2) await recleanChannelNames();
  await SystemConfig.upsert({ key: FIXUP_KEY, value: FIXUP_GENERATION });
}

/** Generation 1: rows with a TMDB id group by it (see groupKeyFor). */
async function regroupByTmdbId(): Promise<void> {
  const [, meta] = await ContentMeta.sequelize!.query(
    "UPDATE content_meta SET groupKey = type || ':tmdb:' || tmdbId WHERE tmdbId IS NOT NULL AND groupKey NOT LIKE '%:tmdb:%'",
  );
  logger.info(`[MetaEnrich] regrouped ${(meta as any)?.changes ?? "?"} rows by TMDB id`);
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
    const hasChannel = !!splitChannel(row.name).channel;
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
    await enrichMovies();
    await enrichSeries();
    await runFixups();
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
