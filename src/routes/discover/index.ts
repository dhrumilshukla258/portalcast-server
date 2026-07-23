import { ServerRoute } from "@hapi/hapi";
import { Op, fn, col } from "sequelize";
import { authCheck } from "@/auth/jwt";
import { ContentMeta, ContentType } from "@/models/ContentMeta";
import { ContentGenre } from "@/models/ContentGenre";
import { ContentCountry } from "@/models/ContentCountry";
import { ContentTheme } from "@/models/ContentTheme";
import { UserProgress } from "@/models/UserProgress";
import { getActiveProfileId } from "@/routes/stalkerV2/shared";
import { getCached, setCached } from "@/services/discoverCache";
import { extractLanguageInfo, extractQualityTags, extractLanguageFromCategoryName } from "@/content/titleClean";
import { UNCATEGORIZED_GENRE } from "@/content/metaEnrichment";
import { readGenres } from "@/infra/storage";
import { logger } from "@/infra/logger";
import { proxiedImageUrl } from "@/providers/portalAssets";
import { getPublicOrigin } from "@/infra/publicUrl";

const PAGE_SIZE = 40;

function unauthorized(h: any) {
  return h.response({ error: "Unauthorized" }).code(401);
}

// The webui's MediaCard component (components/molecules/MediaCard.tsx) reads
// item.screenshot_uri for the poster image — not stream_icon, despite MediaItem
// declaring both fields — and treats an "http"-prefixed value as an absolute URL
// (vs. proxying relative paths through /api/images), which is exactly the shape
// TMDB poster URLs already are. Map to that convention so results render through
// the existing MainContentGrid/MediaCard without any special-casing.
function toMediaItem(row: any, genresById: Map<string, string[]>, countriesById: Map<string, string[]>, origin: string): any {
  return {
    id: row.id,
    // row.id is "movie_{rawId}"/"series_{rawId}" — the webui strips the
    // prefix using this type field to resolve the real movie/series via
    // getMedia/getSeries before it can navigate to a detail page.
    type: row.type,
    // trimmedName is the cleaned display title ("ABC" instead of the raw
    // catalog "ABC - Hindi Dub") — precomputed once at enrichment/migration
    // time (see ContentMeta.ts), falls back to the raw name for any row that
    // predates the column somehow slipping through the migration.
    name: row.trimmedName || row.name,
    title: row.trimmedName || row.name,
    // row.poster is TMDB (image.tmdb.org) when enrichment found a match, but
    // falls back to the raw portal stream_icon/cover otherwise (see
    // metaEnrichment.ts's resolveMeta) — proxiedImageUrl passes TMDB through
    // untouched and only routes the portal fallback through /api/images/proxy.
    screenshot_uri: proxiedImageUrl(row.poster, origin),
    // Any-resolution backdrop — used by the detail-page hero
    // (MediaInfoHeader), which would rather show a lower-res image than none.
    backdrop_path: row.backdrop || undefined,
    // High-res-only backdrop (null unless it clears MIN_BACKDROP_WIDTH, see
    // tmdb.ts) — used by the ambient rotation (AmbientBackdrop.tsx), which
    // skips a title entirely rather than show a soft/upscaled one.
    backdrop_hd_path: row.backdropHd || undefined,
    year: row.year,
    genres_str: (genresById.get(row.id) || []).join(", "),
    country: (countriesById.get(row.id) || []).join(", "),
    // The category this item was actually enriched from — lets the webui's
    // openDiscoverItem pass a real category straight to getMedia/getSeries
    // instead of "*", which forced a live full-catalog portal scan (or, worse,
    // an unreliable click-time cache guess) to resolve it. Undefined for rows
    // enriched before this column existed / not yet backfilled — callers fall
    // back to "*" in that case.
    category: row.portalCategoryId || undefined,
    // Comma-joined, same shape as the portal catalog's own actors field —
    // MediaInfoHeader.tsx's .split(',') handling works unchanged either way.
    actors: row.cast || undefined,
    director: row.director || undefined,
  };
}

async function tagsByContentId(Model: typeof ContentGenre | typeof ContentCountry, contentIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (contentIds.length === 0) return map;
  const rows = await Model.findAll({ where: { contentId: { [Op.in]: contentIds } }, raw: true }) as any[];
  for (const r of rows) {
    const list = map.get(r.contentId) ?? [];
    list.push(r.value);
    map.set(r.contentId, list);
  }
  return map;
}

async function facetCounts(Model: typeof ContentGenre | typeof ContentCountry | typeof ContentTheme, type?: ContentType) {
  // PERF INCIDENT (2026-07-16): filtering to representative-only rows used
  // to require joining back to ContentMeta on every call (including the
  // no-`type` case, which is 100% of real traffic — the webui never actually
  // passes `type` today). That turned a cheap single-table GROUP BY into a
  // full JOIN across content_genres (~850k rows) on every single Discover
  // page load, which brought the whole server down (confirmed: genuine SQLite
  // query cost, not thread-pool starvation — UV_THREADPOOL_SIZE=16 was
  // already correctly applied when this happened). Fixed by denormalizing
  // isRepresentative directly onto the tag tables (kept in sync by
  // recomputeRepresentatives()) — filtering it is now a plain indexed WHERE
  // on the table already being queried, no join needed at all. The `type`
  // filter still needs a join since type only lives on ContentMeta, but
  // that's the rare/currently-unused path, not the hot one.
  const where: any = { isRepresentative: true };
  const include: any[] = type
    ? [{ model: ContentMeta, as: "content", attributes: [], where: { type }, required: true }]
    : [];
  const rows = await Model.findAll({
    attributes: ["value", [fn("COUNT", col("value")), "count"]],
    where,
    include,
    group: ["value"],
    order: [[fn("COUNT", col("value")), "DESC"]],
    raw: true,
  }) as any[];
  return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
}

export const discoverRoutes: ServerRoute[] = [
  {
    // Distinct genres/countries/languages/themes with counts — powers the filter chip UI.
    // Gated by the global onPreHandler Bearer-JWT interceptor in server.ts (paths under
    // /api/ aren't exempted here), same as /api/v2/movies — no per-route authCheck needed.
    method: "GET",
    path: "/api/v2/discover/facets",
    handler: async (request) => {
      const type = (request.query as any).type as ContentType | undefined;

      // Identical result for every user until the next enrichment run — see
      // discoverCache.ts. Cache key just needs to vary by `type`.
      const cacheKey = `facets:${type || "all"}`;
      const cached = getCached<Record<string, unknown>>(cacheKey);
      if (cached) return cached;

      const [genres, countries, themes, languages] = await Promise.all([
        facetCounts(ContentGenre, type),
        facetCounts(ContentCountry, type),
        facetCounts(ContentTheme, type),
        ContentMeta.findAll({
          attributes: ["originalLanguage", [fn("COUNT", col("id")), "count"]],
          where: { ...(type ? { type } : {}), originalLanguage: { [Op.ne]: null }, isRepresentative: true },
          group: ["originalLanguage"],
          order: [[fn("COUNT", col("id")), "DESC"]],
          raw: true,
        }) as unknown as Promise<{ originalLanguage: string; count: number }[]>,
      ]);

      // "Uncategorized" is a catch-all, not a real genre (see UNCATEGORIZED_GENRE
      // in metaEnrichment.ts) — facetCounts() orders by count DESC like every
      // other genre, which could land it anywhere in the list depending on how
      // many titles fall into it. Pin it to the end regardless of count so it
      // reads as "everything else," not as a genre competing on popularity.
      const genresOrdered = [
        ...genres.filter((g) => g.value !== UNCATEGORIZED_GENRE),
        ...genres.filter((g) => g.value === UNCATEGORIZED_GENRE),
      ];

      const result = {
        genres: genresOrdered,
        countries,
        themes,
        languages: languages.map((l: any) => ({ value: l.originalLanguage, count: Number(l.count) })),
      };
      setCached(cacheKey, result);
      return result;
    },
  },

  {
    // Paginated, filtered ContentMeta browse — combine any subset of genre/country/
    // language/theme filters. Each active tag filter joins its respective table;
    // language filters directly on ContentMeta.originalLanguage (not a join table).
    method: "GET",
    path: "/api/v2/discover/browse",
    handler: async (request) => {
      const q = request.query as any;
      const type = q.type as ContentType | undefined;
      const page = Math.max(1, Number(q.page) || 1);

      // Comma-separated for multi-genre (AND — a title must carry every
      // selected genre, e.g. Drama+Comedy narrows to rom-com-shaped titles
      // instead of just being "Drama" alone, which alone runs ~30k deep).
      // Sorted so "Comedy,Drama" and "Drama,Comedy" (same selection, made in
      // a different click order) hit the same cache entry instead of each
      // populating its own redundant copy.
      const genreValues: string[] = q.genre
        ? String(q.genre).split(",").map((v: string) => v.trim()).filter(Boolean).sort()
        : [];
      const genreKey = genreValues.join("+");

      // Same reasoning as facets — browse results (genre/country/language/theme
      // filter combos) are identical for every user, so cache by the exact
      // filter+page combination that was requested.
      const cacheKey = `browse:${type || ""}:${genreKey}:${q.country || ""}:${q.language || ""}:${q.theme || ""}:${page}`;
      const cached = getCached<Record<string, unknown>>(cacheKey);
      if (cached) return cached;

      // One card per real title — every language/format variant of the same
      // title shares a groupKey but only the flagged representative row shows
      // up here; the rest are reachable via /discover/variants on click.
      const where: any = { isRepresentative: true };
      if (type) where.type = type;
      if (q.language) where.originalLanguage = q.language;

      // PERF INCIDENT (2026-07-17): joining ContentMeta -> tag table (the
      // previous approach here) combined with ORDER BY enrichedAt DESC LIMIT
      // never completed under real data volume — confirmed via server logs
      // showing "browse start" with no matching "browse main query took"
      // line ever following it, for minutes, even with the composite
      // (value, contentId) index in place (see db/index.ts). SQLite couldn't
      // use an index to jump straight to the top 40 rows once a join was
      // involved; it had to materialize/sort a much larger joined set first.
      // Fixed by resolving matching contentIds from each tag table directly
      // (a plain indexed WHERE, same pattern /discover/recommendations
      // already uses) and intersecting them in JS, THEN querying ContentMeta
      // by a plain `id IN (...)` — no join, so the enrichedAt sort stays cheap.
      const tagFilters: { model: typeof ContentGenre | typeof ContentCountry | typeof ContentTheme; value: string }[] = [];
      // One filter entry per selected genre — the intersection below already
      // ANDs every entry in this array regardless of dimension, so multiple
      // genre entries naturally AND together the same way genre+country+theme
      // already did across dimensions.
      for (const value of genreValues) tagFilters.push({ model: ContentGenre, value });
      if (q.country) tagFilters.push({ model: ContentCountry, value: q.country });
      if (q.theme) tagFilters.push({ model: ContentTheme, value: q.theme });

      // Cached separately from the page-level cacheKey above (which includes
      // `page`) — the resolved id set for a given genre/country/theme combo
      // is identical across every page of that combo, so without this every
      // scroll (page 2, 3, 4...) was re-running these tag lookups + JS
      // intersection from scratch even though only the page number changed.
      // That redundant work was the actual bottleneck behind "new genre
      // images load slowly while scrolling" — the item list (and therefore
      // the images) can't start loading until this resolves.
      let filteredIds: string[] | null = null;
      if (tagFilters.length > 0) {
        const filterIdsCacheKey = `browseIds:${genreKey}:${q.country || ""}:${q.theme || ""}`;
        const cachedIds = getCached<string[]>(filterIdsCacheKey);
        if (cachedIds) {
          filteredIds = cachedIds;
        } else {
          const idSets = await Promise.all(
            tagFilters.map(async ({ model, value }) => {
              const rows = await model.findAll({
                attributes: ["contentId"],
                where: { value, isRepresentative: true },
                raw: true,
              }) as any[];
              return new Set(rows.map((r) => r.contentId as string));
            })
          );
          filteredIds = [...idSets.reduce((a, b) => new Set([...a].filter((id) => b.has(id))))];
          setCached(filterIdsCacheKey, filteredIds);
        }
        if (filteredIds.length === 0) {
          const empty = { data: [], page, total_items: 0 };
          setCached(cacheKey, empty);
          return empty;
        }
        where.id = { [Op.in]: filteredIds };
      }

      const { rows, count } = await ContentMeta.findAndCountAll({
        where,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        order: [["enrichedAt", "DESC"]],
      });

      const ids = rows.map((r: any) => r.id);
      const [genresById, countriesById] = await Promise.all([
        tagsByContentId(ContentGenre, ids),
        tagsByContentId(ContentCountry, ids),
      ]);

      // Matches the PaginatedResponse<T> shape the webui's api/types/channels.ts and
      // useMediaLibrary.ts pagination logic already expect ({data, page, total_items}),
      // not a bespoke shape — so browse results can reuse the existing append-page logic.
      const result = {
        data: rows.map((r: any) => toMediaItem(r, genresById, countriesById, getPublicOrigin(request))),
        page,
        total_items: count,
      };
      setCached(cacheKey, result);
      return result;
    },
  },

  {
    // "Because you watched X" — content-based recommendations from the user's own
    // UserProgress rows, no cross-user data. For each watched mediaId with a matching
    // ContentMeta row, find other items sharing >=1 genre + the same original_language,
    // excluding anything already watched, ranked by overlap count.
    method: "GET",
    path: "/api/v2/discover/recommendations",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) return unauthorized(h);

      // Optional Movies/Series scoping — matches DiscoverView's active-type
      // toggle (webui's getRecommendations(type) / App.tsx refetch-on-change).
      // Without this, switching to a Movies-only Discover view could still
      // base "Because You Watched" on a series binge and recommend series
      // back, ignoring the user's explicit type selection.
      const { type: typeFilterRaw } = request.query as { type?: string };
      const typeFilter = typeFilterRaw === "movie" || typeFilterRaw === "series" ? typeFilterRaw : null;

      const profileId = await getActiveProfileId();
      const allProgress = await UserProgress.findAll({
        where: { userId: userPayload.userId, profileId },
        order: [["updatedAt", "DESC"]],
        limit: 40,
        raw: true,
      });

      // A row someone opened and immediately closed (a few seconds in) is not
      // a genuine signal of taste — only count it toward recommendations once
      // they've actually watched a meaningful chunk. `meta.progressPercent` is
      // computed client-side at save time (VideoContext.tsx); fall back to
      // deriving it from `progress`/`meta.duration` for older rows saved
      // before that field existed. `completed` rows always count regardless
      // of the stored percent (a completed episode may have a short/odd
      // duration that make percent-based math unreliable).
      const MIN_WATCH_PERCENT = 20;
      const watchPercent = (p: any): number | null => {
        let meta = p.meta;
        if (typeof meta === "string") {
          try { meta = JSON.parse(meta); } catch { meta = null; }
        }
        if (meta && typeof meta.progressPercent === "number") return meta.progressPercent;
        if (meta && typeof meta.duration === "number" && meta.duration > 0 && typeof p.progress === "number") {
          return (p.progress / meta.duration) * 100;
        }
        return null;
      };
      // UserProgress.mediaId is the portal's own playback-FILE id, not
      // ContentMeta's catalog id — for anything opened via Discover, those are
      // proven to genuinely differ (confirmed via real traffic: a movie
      // fetched via category=1 came back reporting an unrelated file id, and
      // that file id was never a valid catalog lookup key at all — same root
      // cause behind several other fixes this session). webui's saveProgress
      // (VideoContext.tsx) now stores ContentMeta's own id directly in
      // `meta.catalogId` when it's known, specifically so this lookup doesn't
      // have to guess — prefer that, falling back to the old
      // movie_{mediaId}/series_{mediaId} guess only for older progress rows
      // saved before this existed.
      const catalogIdFor = (p: any): string | null => {
        let meta = p.meta;
        if (typeof meta === "string") {
          try { meta = JSON.parse(meta); } catch { meta = null; }
        }
        return (meta && typeof meta === "object" && meta.catalogId) || null;
      };
      // Same meta payload also carries the type webui saved at playback time
      // (useProgressTracking.ts: `type: contentType`) — prefer that, falling
      // back to the movie_/series_ catalogId prefix for older rows that
      // predate the explicit field.
      const rowType = (p: any): "movie" | "series" | null => {
        let meta = p.meta;
        if (typeof meta === "string") {
          try { meta = JSON.parse(meta); } catch { meta = null; }
        }
        if (meta && typeof meta === "object" && (meta.type === "movie" || meta.type === "series")) {
          return meta.type;
        }
        const catalogId = catalogIdFor(p);
        if (catalogId?.startsWith("movie_")) return "movie";
        if (catalogId?.startsWith("series_")) return "series";
        return null;
      };
      let progress = allProgress.filter(
        (p: any) => p.completed || (watchPercent(p) ?? 0) >= MIN_WATCH_PERCENT
      );
      if (typeFilter) {
        progress = progress.filter((p: any) => rowType(p) === typeFilter);
      }
      progress = progress.slice(0, 20);
      if (progress.length === 0) return { data: [], basedOnTitle: null };

      const watchedIds = progress.flatMap((p: any) => {
        const catalogId = catalogIdFor(p);
        return catalogId ? [catalogId] : [`movie_${p.mediaId}`, `series_${p.mediaId}`];
      });
      const watchedMeta = await ContentMeta.findAll({
        where: { id: { [Op.in]: watchedIds } },
        include: [{ model: ContentGenre, as: "ContentGenres" }],
      });
      if (watchedMeta.length === 0) return { data: [] };

      // Exclude by title-group, not just exact id — otherwise a user who
      // watched "ABC Tamil" could still get "ABC" (a different variant of the
      // same title, e.g. "ABC Telugu") recommended back to them as if it were
      // a new title, since grouping means the representative shown for that
      // groupKey might not be the exact variant they watched.
      const watchedGroupKeys = [...new Set((watchedMeta as any[]).map((m) => m.groupKey).filter(Boolean))];

      // The single most-recently-watched title, used purely to label the row
      // ("Because You Watched X") — the actual ranking below still considers
      // genre overlap across all up-to-20 recent watches, not just this one.
      const mostRecentCatalogId = catalogIdFor(progress[0]);
      const mostRecentIds = mostRecentCatalogId
        ? [mostRecentCatalogId]
        : [`movie_${progress[0].mediaId}`, `series_${progress[0].mediaId}`];
      const mostRecentWatched = (watchedMeta as any[]).find((m) => mostRecentIds.includes(m.id));
      // ContentMeta match can miss (unenriched portal item, or a stale
      // movie_{mediaId}/series_{mediaId} guess for pre-catalogId rows) even
      // though other watched titles matched fine — falling straight to a
      // titleless row in that case ("Because You Watched" with no name) when
      // webui's own progress payload (useProgressTracking.ts) already carries
      // the title it displayed during playback. Use that as a fallback
      // instead of leaving basedOnTitle null.
      let mostRecentMeta: any = progress[0].meta;
      if (typeof mostRecentMeta === "string") {
        try { mostRecentMeta = JSON.parse(mostRecentMeta); } catch { mostRecentMeta = null; }
      }
      const mostRecentPlaybackTitle =
        (mostRecentMeta && typeof mostRecentMeta === "object" && (mostRecentMeta.title || mostRecentMeta.name)) || null;
      const basedOnTitle = mostRecentWatched
        ? (mostRecentWatched.trimmedName || mostRecentWatched.name)
        : mostRecentPlaybackTitle;
      if (!mostRecentWatched) {
        logger.info(
          { mostRecentIds, fellBackToPlaybackTitle: !!mostRecentPlaybackTitle },
          "[Discover] recommendations: most-recently-watched title missed ContentMeta lookup"
        );
      }

      const genreCounts = new Map<string, number>();
      const languages = new Set<string>();
      for (const item of watchedMeta as any[]) {
        if (item.originalLanguage) languages.add(item.originalLanguage);
        for (const g of item.ContentGenres || []) {
          genreCounts.set(g.value, (genreCounts.get(g.value) || 0) + 1);
        }
      }
      const topGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g);
      if (topGenres.length === 0) return { data: [] };

      // Rank by overlap count IN SQL (GROUP BY + ORDER BY) before limiting —
      // truncating to an arbitrary N candidates first and only scoring/sorting
      // afterward (the previous approach) could silently exclude the actual
      // highest-overlap titles whenever more than N rows matched topGenres,
      // contradicting the "ranked by overlap" behavior this endpoint promises.
      const overlapRows = (await ContentGenre.findAll({
        attributes: ["contentId", [fn("COUNT", col("ContentGenre.value")), "overlap"]],
        // isRepresentative filtered directly here too (denormalized column,
        // see ContentGenre.ts) — lets SQLite narrow ContentGenre rows via an
        // indexed seek before even attempting the join below, on top of the
        // existing value/contentId scoping. groupKey/originalLanguage still
        // require the join since those only live on ContentMeta — but this
        // query was already scoped to `value IN topGenres` (at most 5 values)
        // before the join runs, unlike facetCounts' unscoped full-table join,
        // so it was never the dangerous case — this is a belt-and-suspenders
        // consistency improvement, not a fix for a repeat of that incident.
        where: { value: { [Op.in]: topGenres }, contentId: { [Op.notIn]: watchedIds }, isRepresentative: true },
        include: [
          {
            model: ContentMeta,
            as: "content",
            attributes: [],
            where: {
              ...(typeFilter ? { type: typeFilter } : {}),
              ...(watchedGroupKeys.length > 0 ? { groupKey: { [Op.notIn]: watchedGroupKeys } } : {}),
              ...(languages.size > 0 ? { originalLanguage: { [Op.in]: [...languages] } } : {}),
            },
            required: true,
          },
        ],
        group: ["ContentGenre.contentId"],
        order: [[fn("COUNT", col("ContentGenre.value")), "DESC"]],
        limit: PAGE_SIZE,
        raw: true,
      })) as unknown as { contentId: string }[];
      if (overlapRows.length === 0) return { data: [] };

      const topIds = overlapRows.map((r) => r.contentId);
      const topMeta = await ContentMeta.findAll({ where: { id: { [Op.in]: topIds } } });
      const metaById = new Map((topMeta as any[]).map((m) => [m.id, m]));
      // ContentMeta.findAll with Op.in doesn't preserve `topIds`' order — re-apply
      // the overlap-ranked order explicitly.
      const top = topIds.map((id) => metaById.get(id)).filter(Boolean);

      const ids = top.map((r: any) => r.id);
      const [genresById, countriesById] = await Promise.all([
        tagsByContentId(ContentGenre, ids),
        tagsByContentId(ContentCountry, ids),
      ]);

      return {
        data: top.map((r: any) => toMediaItem(r, genresById, countriesById, getPublicOrigin(request))),
        basedOnTitle,
      };
    },
  },

  {
    // All language/format variants sharing a title's groupKey — powers the
    // "which version?" picker when a user clicks a Discover card that turned
    // out to have more than one variant (e.g. "ABC Tamil", "ABC South Dub").
    method: "GET",
    path: "/api/v2/discover/variants",
    handler: async (request, h) => {
      const { id } = request.query as { id?: string };
      if (!id) return h.response({ error: "Missing id" }).code(400);

      const anchor = await ContentMeta.findByPk(id, { raw: true });
      if (!anchor || !(anchor as any).groupKey) return { variants: [] };

      const rows = await ContentMeta.findAll({
        where: { groupKey: (anchor as any).groupKey },
        order: [["isRepresentative", "DESC"], ["name", "ASC"]],
      });

      const ids = rows.map((r: any) => r.id);
      const profileId = await getActiveProfileId();
      const [genresById, countriesById, movieCategories, seriesCategories] = await Promise.all([
        tagsByContentId(ContentGenre, ids),
        tagsByContentId(ContentCountry, ids),
        readGenres("movie", profileId ?? undefined),
        readGenres("series", profileId ?? undefined),
      ]);
      const movieCategoryNameById = new Map(movieCategories.map((g: any) => [String(g.id), g.title as string]));
      const seriesCategoryNameById = new Map(seriesCategories.map((g: any) => [String(g.id), g.title as string]));

      return {
        variants: rows.map((r: any) => {
          // Category name (e.g. "Hindi | Dubbed") is the ground truth for
          // this file's actual AUDIO — takes priority over parsing the raw
          // catalog title, which this portal's own tags can contradict (e.g.
          // "Eng Dub"/"En HD" both actually mean Hindi audio here, not
          // English — see LANGUAGE_ALIASES). Title-text parsing is only the
          // fallback for whatever category name doesn't resolve, and still
          // the only source for a "Sub" (subtitled, not dubbed) signal, which
          // category naming doesn't distinguish.
          const categoryName = (r.type === "series" ? seriesCategoryNameById : movieCategoryNameById).get(
            String(r.portalCategoryId)
          );
          const categoryAudio = categoryName ? extractLanguageFromCategoryName(categoryName) : null;
          const { audio: titleAudio, subtitles } = extractLanguageInfo(r.name);
          const audio = categoryAudio || titleAudio;

          // "X Dub"/bare "X" means the AUDIO is X; "X Sub" means the
          // original audio was kept and only subtitled in X — these are not
          // interchangeable, so the label must say which is which rather
          // than just joining every matched tag together.
          let languagePart: string | null;
          if (audio && subtitles && audio !== subtitles) {
            languagePart = `${audio} (+ ${subtitles} Subtitles)`;
          } else if (audio) {
            languagePart = audio;
          } else if (subtitles) {
            languagePart = `Original Audio (${subtitles} Subtitles)`;
          } else {
            languagePart = null;
          }

          const qualityTags = extractQualityTags(r.name);
          const qualitySuffix = qualityTags.length > 0 ? ` ${qualityTags.join(" ")}` : "";

          // Keep the label short — a language/quality tag, never the whole
          // raw catalog name — falling back to the bare name only when we
          // truly have neither signal to offer.
          const variantLabel = languagePart
            ? `${languagePart}${qualitySuffix}`
            : qualityTags.length > 0
              ? qualityTags.join(" ")
              : r.name;

          return { ...toMediaItem(r, genresById, countriesById, getPublicOrigin(request)), variantLabel };
        }),
      };
    },
  },
];
