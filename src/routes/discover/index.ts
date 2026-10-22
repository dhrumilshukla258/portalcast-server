import { fetchPerson } from "@/content/tmdb";
import { personDetails } from "@/content/people";
import { searchPeople, peopleIndexReady } from "@/content/peopleSearch";
import { getCached, setCached } from "@/services/discoverCache";
import { titleKeyOf } from "@/content/people";
import { LOCAL_CATEGORY } from "@/content/metaEnrichment";
import { localVersionLabel } from "@/content/library/catalog";
import { categoryNames, iptvVersionLabel } from "@/content/versionLabel";
import { artUrl } from "@/content/library/art";
import { ratingFields } from "@/content/titleRatings";
import { stripReleaseNoise, channelOf } from "@/content/titleClean";
import { channelLogo, isLiveChannel } from "@/content/channels";
import { PLATFORMS } from "@/content/channelNames";
import { ServerRoute } from "@hapi/hapi";
import { withVideoInfo, getVideoInfo, ensureMediaInfoLoaded } from "@/content/mediaInfo";
import { Op } from "sequelize";
import { authCheck } from "@/auth/jwt";
import { ContentMeta, ContentType } from "@/models/ContentMeta";
import { ContentGenre } from "@/models/ContentGenre";
import { ContentTheme } from "@/models/ContentTheme";
import { UserProgress } from "@/models/UserProgress";
import { getActiveProfileId } from "@/routes/stalkerV2/shared";
import { getHiddenContentKeys, getHiddenContentKeySet } from "@/content/overrides";
import { getDiscoverIndex, facetsFor, browse as browseIndex, recommend, type BrowseQuery } from "@/content/discoverIndex";
import { UNCATEGORIZED_GENRE } from "@/content/metaEnrichment";
import { logger } from "@/infra/logger";
import { proxiedImageUrl } from "@/providers/portalAssets";
import { getPublicOrigin } from "@/infra/publicUrl";
import { titleRows, titleWithGroup, titlePeople, variantRows, personTitles } from "@/content/catalog/cards";

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
  // The channel in the name ("Zee5 : Manemagalu") is shown as a logo, not as text. Rows
  // cleaned before the channel list existed still carry it in trimmedName, so a name with
  // a channel is cleaned again here (stripReleaseNoise is a few regexes).
  const network = channelOf(row.name);
  const cleaned = network ? stripReleaseNoise(row.name) || row.trimmedName || row.name : row.trimmedName || row.name;
  // "Kim's Convenience 2016" -> "Kim's Convenience": a trailing year equal to the title's own
  // year is shown next to it already. Titles that end in another year ("Blade Runner 2049")
  // are untouched.
  const year = String(row.year || "").trim();
  const withoutYear = /^\d{4}$/.test(year) ? cleaned.replace(new RegExp(`[\\s_\\-]*[(\\[]?${year}[)\\]]?\\s*$`), "").trim() : cleaned;
  const displayName = withoutYear || cleaned;
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
    name: displayName,
    title: displayName,
    network: network || undefined,
    network_logo: channelLogo(network, origin) || undefined,
    // row.poster is TMDB (image.tmdb.org) when enrichment found a match, but
    // falls back to the raw portal stream_icon/cover otherwise (see
    // metaEnrichment.ts's resolveMeta) — proxiedImageUrl passes TMDB through
    // untouched and only routes the portal fallback through /api/images/proxy.
    screenshot_uri: proxiedImageUrl(row.poster, origin),
    // Any-resolution backdrop — used by the detail-page hero
    // (MediaInfoHeader), which would rather show a lower-res image than none.
    backdrop_path: row.backdrop ? proxiedImageUrl(row.backdrop, origin) : undefined,
    // High-res-only backdrop (null unless it clears MIN_BACKDROP_WIDTH, see
    // tmdb.ts) — used by the ambient rotation (AmbientBackdrop.tsx), which
    // skips a title entirely rather than show a soft/upscaled one.
    backdrop_hd_path: row.backdropHd ? proxiedImageUrl(row.backdropHd, origin) : undefined,
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
    description: row.overview || undefined,
    // ONE rating per title (content/titleRatings.ts), the same for every version of it.
    ...ratingFields(row),
    // A title you own on the NAS (its card is the local version when there is one).
    is_local: row.portalCategoryId === "local" ? 1 : undefined,
    // Detail fields, as detailed as Jellyfin's (TMDB, or a local title's NFO).
    tagline: row.tagline || undefined,
    rating_mpaa: row.ageRating || undefined,
    runtime: row.runtime || undefined,
    studios: row.studios || undefined,
    collection: row.collection || undefined,
    writers: row.writers || undefined,
    premiered: row.premiered || undefined,
    logo_path: row.logo ? proxiedImageUrl(row.logo, origin) : undefined,
  };
}



/**
 * Everything a detail page shows beyond the card: tagline, age rating, runtime, studios,
 * collection, writers, logo, and the cast and crew with characters and photos. `id` is any
 * content id ("movie_123", "series_L4"); fields the row lacks are taken from another
 * version of the same title (its group).
 */
async function titleDetails(id: string, origin: string) {
  // The title and every version of it, and their people: from the catalog snapshot when it
  // is on, with anything written since read from the database (content/catalog/cards.ts).
  const found = await titleWithGroup(id);
  if (!found) return null;
  const { row, members } = found;
  const first = (f: string) => members.map((m: any) => m[f]).find((v) => v != null && v !== "") ?? null;
  // People: this copy's own list (a locked NFO) first, then the title's shared list, then
  // any other version's (content/people.ts).
  const people = await titlePeople([row.id, titleKeyOf(row as any), ...members.flatMap((m: any) => [m.id, titleKeyOf(m as any)])]);
  // `id` opens the person's page (GET /api/v2/people/{id}).
  const by = (kind: string) => people.filter((p) => p.kind === kind).map((p) => ({ id: p.id, name: p.name, role: p.role, photo: p.photo ? proxiedImageUrl(p.photo, origin) : null }));
  return {
    id,
    tagline: first("tagline"),
    ageRating: first("ageRating"),
    runtime: first("runtime"),
    studios: first("studios"),
    collection: first("collection"),
    originalTitle: first("originalTitle"),
    premiered: first("premiered"),
    writers: first("writers"),
    logo: first("logo") ? proxiedImageUrl(first("logo"), origin) : null,
    cast: by("cast"),
    directors: by("director"),
    writersPeople: by("writer"),
    creators: by("creator"),
  };
}

export const discoverDetailsRoute = {
  method: "GET" as const,
  path: "/api/v2/discover/details",
  handler: async (request: any, h: any) => {
    const q = request.query as any;
    // A content id, or type + the catalog id the apps browse by ("movie" + "123").
    const id = q.id ? String(q.id) : q.type && q.raw ? `${q.type === "series" ? "series" : "movie"}_${q.raw}` : "";
    if (!/^(movie|series)_[\w.-]+$/.test(id)) return h.response({ error: "Give id (movie_123) or type and raw" }).code(400);
    const d = await titleDetails(id, getPublicOrigin(request));
    return d ?? h.response({ error: "Unknown title" }).code(404);
  },
};

/**
 * A person's page: who they are (photo, biography, known for, born) and every title of theirs
 * in the catalog, one card per title with their roles in it, newest first. Biography and the
 * like come from TMDB the first time the page is opened (content/people.ts).
 */
/**
 * A person's page payload, cached in memory (Discover's cache: cleared when enrichment or a
 * content-manager edit changes the catalog, 10 min otherwise) and built once however many
 * clients ask at the same moment. Keyed by origin: image URLs carry it.
 */
interface PersonPagePayload {
  /** The response of GET /api/v2/people/{id}: credits newest first. */
  page: { person: any; credits: any[] };
  /** The same credits, best known first: titles they lead, then the most rated. */
  knownFor: any[];
}
const personInflight = new Map<string, Promise<PersonPagePayload | null>>();
async function personPage(id: number, origin: string): Promise<PersonPagePayload | null> {
  const key = `person:${id}:${origin}`;
  const cached = getCached<PersonPagePayload>(key);
  if (cached) return cached;
  const running = personInflight.get(key);
  if (running) return running;
  const work = (async () => {
    const person = await personDetails(id, fetchPerson);
    if (!person) return null;
    const hidden = await getHiddenContentKeySet();
    // Their titles and those titles' tags: the catalog snapshot when it is on (content/catalog/cards.ts).
    const credits = (await personTitles(id)).filter((c) => !hidden.has(c.row.id));
    const ids = credits.map((c) => c.row.id);
    const { genres: genresById, countries: countriesById } = await titleRows(ids);
    const items = credits.map((c) => ({ ...toMediaItem(c.row, genresById, countriesById, origin), roles: c.roles }));
    const votes = (r: any) => Math.max(Number(r.imdbVotes) || 0, Number(r.ratingCount) || 0);
    const order = credits.map((c, i) => ({ i, lead: c.lead ? 1 : 0, v: votes(c.row) })).sort((a, b) => b.lead - a.lead || b.v - a.v);
    const payload: PersonPagePayload = {
      page: { person: { ...person, photo: person.photo ? proxiedImageUrl(person.photo, origin) : null }, credits: items },
      knownFor: order.map((o) => items[o.i]),
    };
    setCached(key, payload);
    return payload;
  })().finally(() => personInflight.delete(key));
  personInflight.set(key, work);
  return work;
}

export const personRoute = {
  method: "GET" as const,
  path: "/api/v2/people/{id}",
  handler: async (request: any, h: any) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return h.response({ error: "Bad id" }).code(400);
    const p = await personPage(id, getPublicOrigin(request));
    return p ? p.page : h.response({ error: "Unknown person" }).code(404);
  },
};

/** Titles shown under a featured person in search ("Movies & series with ..."). */
const FEATURED_TITLES = 24;

/**
 * `GET /api/v2/search/people?q=&limit=`: people by name from the in-memory index
 * (content/peopleSearch.ts), plus, when the query clearly names one person, their titles
 * so the client shows "Movies & series with X" without a second request.
 */
export const peopleSearchRoute = {
  method: "GET" as const,
  path: "/api/v2/search/people",
  handler: async (request: any) => {
    const q = String(request.query.q ?? "").slice(0, 100);
    const limit = Math.min(60, Math.max(1, Number(request.query.limit) || 30));
    const { people, featured } = searchPeople(q, limit);
    const origin = getPublicOrigin(request);
    const photo = (p: string | null) => (p ? proxiedImageUrl(p, origin) : null);
    let featuredOut: any = null;
    if (featured) {
      const p = await personPage(featured.id, origin);
      if (p?.knownFor.length) featuredOut = { id: featured.id, name: featured.name, credits: p.knownFor.slice(0, FEATURED_TITLES), total: p.knownFor.length };
    }
    return {
      people: people.map((p) => ({ ...p, photo: photo(p.photo) })),
      featured: featuredOut,
      ready: peopleIndexReady(),
    };
  },
};

export const discoverRoutes: ServerRoute[] = [
  {
    // Distinct genres/countries/languages/themes with counts — powers the filter chip UI.
    // Gated by the global onPreHandler Bearer-JWT interceptor in server.ts (paths under
    // /api/ aren't exempted here), same as /api/v2/movies — no per-route authCheck needed.
    method: "GET",
    path: "/api/v2/discover/facets",
    handler: async (request) => {
      const type = (request.query as any).type as ContentType | undefined;
      // Precomputed per type in the in-memory index (content/discoverIndex.ts).
      const f = facetsFor(await getDiscoverIndex(), type);
      // "Uncategorized" is a catch-all, not a real genre (see UNCATEGORIZED_GENRE in
      // metaEnrichment.ts): pin it to the end so it reads as "everything else".
      return {
        genres: [
          ...f.genres.filter((g) => g.value !== UNCATEGORIZED_GENRE),
          ...f.genres.filter((g) => g.value === UNCATEGORIZED_GENRE),
        ],
        countries: f.countries,
        themes: f.themes,
        languages: f.languages,
        // Channels shows air on, with their logos (from the live channel list).
        // "Channel / Platform": TV channels that exist in Live TV, plus streaming platforms and
        // the generic "Urdu TV" (never in Live TV). A channel the portal does not carry keeps
        // its clean name and badge but is not offered.
        // Series only: channels and platforms are a series thing (in Movies the list would be a
        // handful of award shows), so the filter is offered only when Series is selected.
        networks: type !== "series" ? [] : f.networks.filter((n) => isLiveChannel(n.value) || PLATFORMS.has(n.value)).map((n) => ({ ...n, logo: channelLogo(n.value, getPublicOrigin(request)) || undefined })),
      };
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

      // Answered from the in-memory index (content/discoverIndex.ts): tag postings are
      // intersected in memory and only this page's rows are read, by primary key. One card
      // per real title: only representative rows are indexed (variants are reachable via
      // /discover/variants). Multiple genres AND together, as do genre+country+theme.
      // Hidden titles (admin or broken-stream auto-hide) are skipped at query time.
      const tags: BrowseQuery["tags"] = genreValues.map((value) => ({ kind: "genre" as const, value }));
      if (q.country) tags.push({ kind: "country", value: String(q.country) });
      if (q.theme) tags.push({ kind: "theme", value: String(q.theme) });
      if (q.network) tags.push({ kind: "network", value: String(q.network) });
      const [idx, hidden] = await Promise.all([getDiscoverIndex(), getHiddenContentKeySet()]);
      const { ids, total } = browseIndex(idx, {
        type, language: q.language ? String(q.language) : undefined, tags, hidden, page, pageSize: PAGE_SIZE,
      });

      // The page's rows and tags: from the catalog snapshot when it is on (titles changed since
      // it was built are read from the database), else from the database (catalog/cards.ts).
      const { rows: byId, genres: genresById, countries: countriesById } = await titleRows(ids);
      const rows = ids.map((id) => byId.get(id)).filter(Boolean) as any[];

      // Same PaginatedResponse<T> shape the clients' pagination already expects.
      return {
        data: await withVideoInfo(
          rows.map((r: any) => toMediaItem(r, genresById, countriesById, getPublicOrigin(request))),
          await getActiveProfileId(), "movie", (x: any) => (x.type === "movie" ? x.id : undefined),
        ),
        page,
        total_items: total,
      };
    },
  },

  {
    // Several genre rows at once (first page each): Discover's home rows in one request
    // instead of one per row. Each row is picked from the in-memory index; the titles of
    // all rows are read in one query. `genres` is comma-separated, at most 12.
    method: "GET",
    path: "/api/v2/discover/rows",
    handler: async (request) => {
      const q = request.query as any;
      const type = q.type as ContentType | undefined;
      const genres = [...new Set(String(q.genres ?? "").split(",").map((g: string) => g.trim()).filter(Boolean))].slice(0, 12);
      if (!genres.length) return { rows: [] };
      const [idx, hidden] = await Promise.all([getDiscoverIndex(), getHiddenContentKeySet()]);
      const picked = genres.map((genre) => ({
        genre,
        ...browseIndex(idx, { type, tags: [{ kind: "genre" as const, value: genre }], hidden, page: 1, pageSize: PAGE_SIZE }),
      }));
      const allIds = [...new Set(picked.flatMap((p) => p.ids))];
      const { rows: byRowId, genres: genresById, countries: countriesById } = await titleRows(allIds);
      const found = allIds.map((id) => byRowId.get(id)).filter(Boolean) as any[];
      const origin = getPublicOrigin(request);
      const items = await withVideoInfo(
        found.map((r: any) => toMediaItem(r, genresById, countriesById, origin)),
        await getActiveProfileId(), "movie", (x: any) => (x.type === "movie" ? x.id : undefined),
      );
      const byId = new Map(items.map((it: any) => [String(it.id), it]));
      return {
        rows: picked.map((p) => ({ genre: p.genre, data: p.ids.map((id) => byId.get(id)).filter(Boolean), page: 1, total_items: p.total })),
      };
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

      // Ranked by genre overlap in the in-memory index (content/discoverIndex.ts), ties
      // newest first. Excludes everything watched by title GROUP, not just exact id, so a
      // user who watched "ABC Tamil" is not offered "ABC Telugu" as if it were new.
      const [idx, hidden, groupRows] = await Promise.all([
        getDiscoverIndex(),
        getHiddenContentKeySet(),
        watchedGroupKeys.length > 0
          ? ContentMeta.findAll({ where: { groupKey: { [Op.in]: watchedGroupKeys } }, attributes: ["id"], raw: true })
          : Promise.resolve([] as any[]),
      ]);
      const exclude = new Set<string>([...watchedIds, ...hidden, ...(groupRows as any[]).map((r) => r.id as string)]);
      const topIds = recommend(idx, {
        genres: topGenres, languages: [...languages], type: typeFilter ?? undefined, exclude, limit: PAGE_SIZE,
      });
      if (topIds.length === 0) return { data: [] };

      const { rows: metaById, genres: genresById, countries: countriesById } = await titleRows(topIds);
      const top = topIds.map((id) => metaById.get(id)).filter(Boolean);

      return {
        data: await withVideoInfo(
          top.map((r: any) => toMediaItem(r, genresById, countriesById, getPublicOrigin(request))),
          profileId, "movie", (x: any) => (x.type === "movie" ? x.id : undefined),
        ),
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

      // Every version sharing the title's groupKey, representative first, then by name
      // (content/catalog/cards.ts: the snapshot when on, the database otherwise).
      const rows = await variantRows(id, await getHiddenContentKeys());
      if (rows.length === 0) return { variants: [] };

      const ids = rows.map((r: any) => r.id);
      const profileId = await getActiveProfileId();
      await ensureMediaInfoLoaded();
      const [{ genres: genresById, countries: countriesById }, names] = await Promise.all([
        titleRows(ids),
        categoryNames(profileId),
      ]);
      // Local-library versions say "Local" and their files' languages (the title has no tags).
      const localLabels = new Map<string, string | null>();
      for (const r of rows as any[]) if (r.portalCategoryId === LOCAL_CATEGORY) localLabels.set(r.id, await localVersionLabel(r.id));

      return {
        variants: rows.map((r: any) => {
          // A measured resolution (content/mediaInfo.ts) beats the quality words in the
          // title: "Ek Din HDCam" that decodes as 1080p is labelled "1080p".
          const measured = r.type === "movie" ? getVideoInfo(profileId ?? 0, "movie", r.id) : undefined;
          const variantLabel = localLabels.has(r.id)
            ? localLabels.get(r.id) || "Local"
            : iptvVersionLabel(r.name, names[r.type === "series" ? "series" : "movie"].get(String(r.portalCategoryId)), measured?.label);

          return {
            ...toMediaItem(r, genresById, countriesById, getPublicOrigin(request)),
            variantLabel,
            ...(measured ? { video: measured } : {}),
          };
        }),
      };
    },
  },
];
