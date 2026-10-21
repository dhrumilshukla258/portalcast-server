import { setting } from "@/config/settings";
import axios from "axios";
import { stripReleaseNoise } from "@/content/titleClean";
import { countryLabel } from "@/content/countryNames";

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE  = "https://image.tmdb.org/t/p";

// Same channel-prefix/quality/language stripping normalizeTitleKey uses to group duplicate
// portal listings — searching TMDB with that same cleaned title gets much better matches
// than the portal's raw (often noisy) name.
function cleanTitle(name: string): string {
  return stripReleaseNoise(name);
}

async function tmdbGet(path: string): Promise<any | null> {
  const tmdbApiToken = setting<string>("tmdbToken");
  if (!tmdbApiToken) return null;
  try {
    const { data } = await axios.get(`${TMDB_BASE}${path}`, {
      headers: { Authorization: `Bearer ${tmdbApiToken}` },
      timeout: 5000,
    });
    return data;
  } catch {
    return null;
  }
}

export interface TmdbMeta {
  poster: string | null;
  // Best backdrop TMDB has, any resolution — used for the detail-page hero
  // (MediaInfoHeader), where showing *something* beats showing nothing.
  backdrop: string | null;
  // Same pool, but only set when the pick also clears MIN_BACKDROP_WIDTH —
  // used for the ambient rotation (AmbientBackdrop), which would rather skip
  // a title than show a soft/upscaled-looking backdrop for it.
  backdropHd: string | null;
  overview: string | null;
  cast: string | null;
  director: string | null;
  trailerKey: string | null;
  tmdbId: number;
  genres: string[];
  originalLanguage: string | null;
  countries: string[];
  keywordIds: number[];
  // TMDB's own resolved release year — distinct from the `year` a caller may
  // have extracted from the raw provider title text (used only to bias the
  // search query, see `search()`'s yearParam). Two catalog entries for the
  // same real title can differ in whether their raw text happened to contain
  // a parseable year at all, which silently produced different `groupKey`s
  // for what TMDB confirms is the same title — this is the authoritative
  // value to group by once a TMDB match exists.
  releaseYear: string | null;
  // TMDB's user score (0-10, one decimal) and how many votes it rests on.
  rating: number | null;
  ratingCount: number | null;
  // "tt0111161": movies carry it on the details, series under external_ids.
  imdbId: string | null;
  // Everything else a detail page shows, as detailed as Jellyfin's NFO files.
  details: TitleDetails;
}

export interface TitlePerson {
  kind: "cast" | "director" | "writer" | "creator";
  name: string;
  /** Character (cast) or job ("Screenplay"). */
  role: string | null;
  order: number;
  tmdbPersonId: number | null;
  photo: string | null;
}

export interface TitleDetails {
  tagline: string | null;
  /** Age rating: "PG-13", "TV-14", "U/A 13+". */
  ageRating: string | null;
  /** Minutes (a series: its usual episode length). */
  runtime: number | null;
  /** Production companies (movie) or networks (series), most important first. */
  studios: string[];
  /** "The Dark Knight Collection". */
  collection: string | null;
  originalTitle: string | null;
  /** First release / first air date, YYYY-MM-DD. */
  premiered: string | null;
  /** Transparent title logo (original size). */
  logo: string | null;
  people: TitlePerson[];
}

const CERT_COUNTRIES = ["US", "IN", "GB", "CA", "AU"];

function ageRatingOf(detail: any, kind: "movie" | "tv"): string | null {
  if (kind === "movie") {
    const results: any[] = detail?.release_dates?.results || [];
    for (const c of CERT_COUNTRIES) {
      const rel = results.find((r) => r.iso_3166_1 === c);
      const cert = (rel?.release_dates || []).map((d: any) => String(d.certification || "").trim()).find(Boolean);
      if (cert) return cert;
    }
    return null;
  }
  const results: any[] = detail?.content_ratings?.results || [];
  for (const c of CERT_COUNTRIES) {
    const r = results.find((x) => x.iso_3166_1 === c && String(x.rating || "").trim());
    if (r) return String(r.rating).trim();
  }
  return null;
}

function logoOf(detail: any): string | null {
  const logos: any[] = detail?.images?.logos || [];
  const pick = [...logos].sort(
    (a, b) =>
      Number(b.iso_639_1 === "en") - Number(a.iso_639_1 === "en") ||
      Number(b.file_path?.endsWith(".png")) - Number(a.file_path?.endsWith(".png")) ||
      (b.vote_average || 0) - (a.vote_average || 0),
  )[0];
  return pick?.file_path ? `${IMG_BASE}/original${pick.file_path}` : null;
}

const WRITER_JOBS = new Set(["Screenplay", "Writer", "Story", "Novel", "Author", "Teleplay", "Characters"]);

function peopleOf(detail: any, kind: "movie" | "tv"): TitlePerson[] {
  const photo = (p: any) => (p?.profile_path ? `${IMG_BASE}/w185${p.profile_path}` : null);
  const out: TitlePerson[] = [];
  const credits = kind === "tv" ? detail?.aggregate_credits ?? detail?.credits : detail?.credits;
  (credits?.cast || []).slice(0, 20).forEach((c: any, i: number) => {
    if (!c?.name) return;
    const role = c.character ?? c.roles?.[0]?.character ?? null;
    out.push({ kind: "cast", name: c.name, role: role || null, order: c.order ?? i, tmdbPersonId: c.id ?? null, photo: photo(c) });
  });
  const crew: any[] = detail?.credits?.crew || [];
  const seen = new Set<string>();
  crew.forEach((c: any, i: number) => {
    if (!c?.name) return;
    const kindOf = c.job === "Director" ? "director" : WRITER_JOBS.has(c.job) ? "writer" : null;
    if (!kindOf || seen.has(`${kindOf}:${c.name}`)) return;
    seen.add(`${kindOf}:${c.name}`);
    out.push({ kind: kindOf, name: c.name, role: kindOf === "writer" ? c.job : null, order: i, tmdbPersonId: c.id ?? null, photo: photo(c) });
  });
  (detail?.created_by || []).forEach((c: any, i: number) => {
    if (c?.name) out.push({ kind: "creator", name: c.name, role: null, order: i, tmdbPersonId: c.id ?? null, photo: photo(c) });
  });
  return out;
}

function detailsOf(detail: any, kind: "movie" | "tv"): TitleDetails {
  const runtime = kind === "movie" ? detail?.runtime : (detail?.episode_run_time || [])[0] ?? detail?.last_episode_to_air?.runtime;
  const studios = (kind === "movie" ? detail?.production_companies : detail?.networks) || [];
  const premiered = kind === "movie" ? detail?.release_date : detail?.first_air_date;
  return {
    tagline: String(detail?.tagline || "").trim() || null,
    ageRating: ageRatingOf(detail, kind),
    runtime: Number(runtime) > 0 ? Number(runtime) : null,
    studios: studios.map((x: any) => x?.name).filter(Boolean).slice(0, 4),
    collection: kind === "movie" ? detail?.belongs_to_collection?.name || null : null,
    originalTitle: (kind === "movie" ? detail?.original_title : detail?.original_name) || null,
    premiered: /^\d{4}-\d{2}-\d{2}$/.test(String(premiered || "")) ? premiered : null,
    logo: logoOf(detail),
    people: peopleOf(detail, kind),
  };
}

interface Credits {
  cast: string | null;
  director: string | null;
}

function extractCredits(data: any): Credits {
  if (!data) return { cast: null, director: null };
  const cast = (data.cast || [])
    .slice(0, 8)
    .map((c: any) => c.name)
    .filter(Boolean)
    .join(", ") || null;
  const directorCrew = (data.crew || []).find((c: any) => c.job === "Director");
  return { cast, director: directorCrew?.name || null };
}

function extractTrailerKey(data: any): string | null {
  const videos: any[] = data?.results || [];
  const youtubeTrailers = videos.filter((v) => v.site === "YouTube" && v.type === "Trailer");
  const best = youtubeTrailers.find((v) => v.official) || youtubeTrailers[0];
  return best?.key || null;
}

// TMDB's /movie/{id}/keywords shape is {id, keywords:[]} but /tv/{id}/keywords is
// {id, results:[]} — same append_to_response key ("keywords"), different inner field.
// data.keywords is the wrapper object itself ({id, keywords/results}), not the array —
// verified live against real TMDB responses (Money Heist / Evil Dead Burn) before this
// function was written; the movie branch below regressed that to skip one level of nesting.
function extractKeywordIds(data: any, kind: "movie" | "tv"): number[] {
  const list = kind === "movie" ? data?.keywords?.keywords : data?.keywords?.results;
  return (list || []).map((k: any) => k.id).filter((id: any) => typeof id === "number");
}

// TMDB's own detail.backdrop_path is just whichever single backdrop TMDB
// happened to nominate as "primary" — often not the highest-resolution one
// actually available. detail.images.backdrops (populated via
// append_to_response=images below) lists every backdrop TMDB has for this
// title with its real width/height, so pick the widest one instead of
// trusting the primary pick. 1920px (Full HD) is the floor for what counts
// as "high-res" — true 3840px/4K sources exist but are the exception, not
// the rule, even for popular titles.
const MIN_BACKDROP_WIDTH = 1920;

function pickBestBackdrop(detail: any): { path: string | null; isHd: boolean } {
  const candidates: any[] = detail?.images?.backdrops || [];
  const sorted = [...candidates].sort(
    (a, b) => (b.width || 0) - (a.width || 0) || (b.vote_average || 0) - (a.vote_average || 0)
  );
  const best = sorted[0];
  if (best) return { path: best.file_path, isHd: (best.width || 0) >= MIN_BACKDROP_WIDTH };
  // /images came back empty — fall back to TMDB's own primary pick (unknown
  // resolution, so never counts as HD) rather than having no backdrop at all
  // for the detail-page use case, which doesn't care about resolution.
  return { path: detail.backdrop_path || null, isHd: false };
}

function buildMeta(detail: any, kind: "movie" | "tv"): TmdbMeta {
  const credits = extractCredits(detail.credits);
  // A series has creators, rarely a "Director" credit: store the creators in the same
  // field (clients label it "Created by" for series).
  if (kind === "tv") {
    const creators = (detail.created_by || []).map((c: any) => c?.name).filter(Boolean).join(", ");
    if (creators) credits.director = creators;
  }
  const trailerKey = extractTrailerKey(detail.videos);
  const genres = (detail.genres || []).map((g: any) => g.name).filter(Boolean);
  const backdrop = pickBestBackdrop(detail);
  // Movies' production_countries already carry full names; TV's origin_country
  // is just raw ISO 3166-1 alpha-2 codes (e.g. "IN", "GB") — map to the same
  // full-name convention so the same country doesn't show up twice under two
  // different spellings depending on which content type tagged it.
  const countries = kind === "movie"
    ? (detail.production_countries || []).map((c: any) => c.name).filter(Boolean)
    : (detail.origin_country || []).filter(Boolean).map((code: string) => countryLabel(code));
  const releaseDateStr = kind === "movie" ? detail.release_date : detail.first_air_date;
  const releaseYear = releaseDateStr ? String(releaseDateStr).slice(0, 4) : null;

  return {
    poster:     detail.poster_path ? `${IMG_BASE}/w500${detail.poster_path}`           : null,
    backdrop:   backdrop.path      ? `${IMG_BASE}/original${backdrop.path}`            : null,
    backdropHd: backdrop.path && backdrop.isHd ? `${IMG_BASE}/original${backdrop.path}` : null,
    overview: detail.overview || null,
    rating: detail.vote_count > 0 && detail.vote_average > 0 ? Math.round(detail.vote_average * 10) / 10 : null,
    ratingCount: detail.vote_count > 0 ? detail.vote_count : null,
    imdbId: [detail.imdb_id, detail.external_ids?.imdb_id].find((v) => typeof v === "string" && /^tt\d+$/.test(v)) ?? null,
    cast: credits.cast,
    director: credits.director,
    trailerKey,
    tmdbId: detail.id,
    genres,
    originalLanguage: detail.original_language || null,
    countries,
    keywordIds: extractKeywordIds(detail, kind),
    releaseYear,
    details: detailsOf(detail, kind),
  };
}

// A single append_to_response call combines details+credits+videos+keywords+images into
// one request instead of several separate ones — matters at the scale of a full-catalog
// backfill. `images` carries every backdrop TMDB has (with width/height) so
// pickBestBackdropPath() can choose the highest-resolution one instead of trusting
// detail.backdrop_path's single "primary" pick.
//
// include_image_language=null,en pulls TMDB's language-neutral (textless) backdrops plus
// English ones — without it, TMDB defaults to only the title's *primary* language, and a
// lot of catalog titles (esp. Indian/regional content) have zero backdrops tagged that way,
// silently emptying the candidate list this was added to widen in the first place.
async function fetchDetail(kind: "movie" | "tv", id: number): Promise<any | null> {
  // release_dates / content_ratings carry the age rating; images include logos;
  // aggregate_credits gives a series' whole cast with their characters.
  const extra = kind === "movie" ? "release_dates" : "content_ratings,aggregate_credits";
  return tmdbGet(
    `/${kind}/${id}?append_to_response=credits,videos,keywords,images,external_ids,${extra}&include_image_language=null,en`
  );
}

async function search(kind: "movie" | "tv", query: string, year?: string): Promise<any[]> {
  const q = encodeURIComponent(query);
  const yearParam = kind === "movie"
    ? (year ? `&year=${year}` : "")
    : (year ? `&first_air_date_year=${year}` : "");
  const data = await tmdbGet(`/search/${kind}?query=${q}&language=en-US${yearParam}`);
  return Array.isArray(data?.results) ? data.results : [];
}

// ---- what to search for --------------------------------------------------------------
// Portal names carry more than the quality/language tags stripReleaseNoise removes:
//   "Kim's Convenience 2016"                 -> a year glued to the title (and the portal's
//                                               own releaseDate says 2021, so the year-
//                                               filtered search found nothing)
//   "Diners, Drive-Ins and Dives : Season 40 To Current", "The Yorkshire Vet : Season13 TO
//   Current", "The Fifth Estate : Season : 47 & 48", "Season 1. Pushpa Impossible"
//   "Jack Carr Investigates: Carlos the Jackal" -> TMDB lists only the show "Jack Carr
//                                               Investigates"
// Each name gives a short list of queries, most specific first; the first one with a
// convincing result wins. The raw cleaned title is always tried first so a title that
// really ends in a year ("Death Race 2000", "Blade Runner 2049") is matched as itself.
const TRAILING_YEAR_RE = /\s*[(\[]?((?:19|20)\d{2})[)\]]?\s*$/;

/**
 * The year a portal wrote at the end of a name ("Wonder Woman 1973", "Fire_1996",
 * "Naseeb -1997", "Stereo HD 2023"), after release noise is removed; null when none.
 */
export function titleYearOf(name: string): number | null {
  const m = /(?:^|[\s_\-(\[])((?:19|20)\d{2})[)\]]?\s*$/.exec(cleanTitle(name));
  return m ? Number(m[1]) : null;
}
// ': Season 40 To Current' / ' - Season13 TO Current' / ' : Season : 47 & 48' — only when
// digits follow, so 'Love in the Season' is left alone.
const SEASON_SUFFIX_RE = /\s*[:\-–|]?\s*\bseasons?(?=[\s:\d]|$)\s*:?\s*(?=.*\d).*$/i;
const SEASON_PREFIX_RE = /^\s*season\s*\d+\s*[.:\-–]\s*/i;

export interface TitleQuery {
  query: string;
  year?: string;
  /** Only accept a result whose name equals the query (a loosened query must not guess). */
  strict: boolean;
}

export function tmdbQueries(name: string, year?: string): TitleQuery[] {
  const out: TitleQuery[] = [];
  const seen = new Set<string>();
  const push = (q: string, y: string | undefined, strict: boolean) => {
    const t = q.replace(/\s+/g, " ").trim().replace(/^[\s\-:|,]+|[\s\-:|,]+$/g, "");
    const k = `${t.toLowerCase()}|${y || ""}`;
    if (t.length >= 2 && !seen.has(k)) { seen.add(k); out.push({ query: t, year: y || undefined, strict }); }
  };
  const base = cleanTitle(name).replace(SEASON_PREFIX_RE, "");
  push(base, year, false);
  if (year) push(base, undefined, false);
  const noSeason = base.replace(SEASON_SUFFIX_RE, "").trim();
  if (noSeason && noSeason !== base) { push(noSeason, year, false); push(noSeason, undefined, false); }
  const trailing = TRAILING_YEAR_RE.exec(noSeason);
  if (trailing && trailing.index > 0) {
    const t = noSeason.slice(0, trailing.index).trim();
    // Strict: "Blade Runner 2049" must never fall back to a guess at "Blade Runner".
    if (t) { push(t, trailing[1], true); push(t, undefined, true); }
  }
  const head = noSeason.replace(TRAILING_YEAR_RE, "").split(/\s*[:|]\s*|\s+[\-–]\s+/)[0]?.trim();
  if (head && head.length >= 3 && head.toLowerCase() !== noSeason.toLowerCase()) push(head, undefined, true);
  return out;
}

function normName(s: string): string {
  return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The result that best fits the query: name match first, then year, then popularity. */
export function pickResult(results: any[], q: TitleQuery, kind: "movie" | "tv", titleYear: number | null = null, fullTitle: string | null = null): any | null {
  const full = fullTitle ? normName(fullTitle) : null;
  const want = normName(q.query);
  let best: any = null;
  let bestScore = -Infinity;
  for (const r of results.slice(0, 10)) {
    const names = [r.title, r.name, r.original_title, r.original_name].filter(Boolean).map(normName);
    const exact = names.includes(want);
    const starts = !exact && names.some((n) => n.startsWith(`${want} `) || want.startsWith(`${n} `));
    if (q.strict && !exact) continue;
    const ry = String((kind === "movie" ? r.release_date : r.first_air_date) || "").slice(0, 4);
    // TMDB's title exactly equal to our whole title (number included: "Blade Runner 2049",
    // "Fear Street: 1994") is trusted as is. Otherwise a year written in the name must agree
    // within a year: without this "Wonder Woman 1973" took the 2017 film, "Karz 2002" the
    // 1980 one and "IIFA Awards 2019" a 2023 entry (2026-10-20).
    const sameTitle = full !== null && names.includes(full);
    if (titleYear && !sameTitle) {
      if (!ry || Math.abs(Number(ry) - titleYear) > 1) continue;
    }
    let score = exact ? 100 : starts ? 60 : 20;
    if (q.year && ry) {
      const d = Math.abs(Number(q.year) - Number(ry));
      score += d === 0 ? 30 : d === 1 ? 15 : d <= 3 ? 5 : -10;
    }
    score += Math.min(10, (Number(r.popularity) || 0) / 10);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

async function fetchMeta(kind: "movie" | "tv", name: string, year?: string): Promise<TmdbMeta | null> {
  let r: any = null;
  const titleYear = titleYearOf(name);
  for (const q of tmdbQueries(name, year)) {
    r = pickResult(await search(kind, q.query, q.year), q, kind, titleYear, cleanTitle(name));
    if (r) break;
  }
  if (!r) return null;

  const detail = await fetchDetail(kind, r.id);
  if (!detail) return null;
  return buildMeta(detail, kind);
}

// ---- networks a show airs on (for channel logos) ---------------------------------------
export interface TmdbNetwork { name: string; logo: string | null }

export async function fetchTvNetworks(tmdbId: number): Promise<TmdbNetwork[] | null> {
  const data = await tmdbGet(`/tv/${tmdbId}?language=en-US`);
  if (!data || !Array.isArray(data.networks)) return null;
  return data.networks.map((n: any) => ({
    name: String(n.name || ""),
    // w185 PNG: logos are transparent; TMDB serves .svg originals as .png at sized paths.
    logo: n.logo_path ? `${IMG_BASE}/w185${String(n.logo_path).replace(/\.svg$/i, ".png")}` : null,
  }));
}

// ---- one season's episodes -----------------------------------------------------------
export interface TmdbEpisode {
  number: number;
  name: string | null;
  overview: string | null;
  /** w400 still, about the size an episode row shows. */
  still: string | null;
  /** Minutes. */
  runtime: number | null;
  airDate: string | null;
}

export async function fetchTvSeason(tmdbId: number, season: number): Promise<TmdbEpisode[] | null> {
  const data = await tmdbGet(`/tv/${tmdbId}/season/${season}?language=en-US`);
  if (!data || !Array.isArray(data.episodes)) return null;
  return data.episodes.map((e: any) => ({
    number: Number(e.episode_number) || 0,
    name: e.name || null,
    overview: e.overview || null,
    still: e.still_path ? `${IMG_BASE}/w400${e.still_path}` : null,
    runtime: typeof e.runtime === "number" && e.runtime > 0 ? e.runtime : null,
    airDate: e.air_date || null,
  }));
}

export async function fetchMovieMeta(name: string, year?: string): Promise<TmdbMeta | null> {
  return fetchMeta("movie", name, year);
}

export async function fetchTVMeta(name: string, year?: string): Promise<TmdbMeta | null> {
  return fetchMeta("tv", name, year);
}

// For rows that already have a resolved tmdbId (anything with source
// "tmdb") — skips the search step entirely and goes straight to fetchDetail,
// so a targeted backdrop refresh over already-enriched content doesn't waste
// a search call (and its own risk of matching the wrong title) per row.
export async function fetchMetaByTmdbId(kind: "movie" | "tv", tmdbId: number): Promise<TmdbMeta | null> {
  const detail = await fetchDetail(kind, tmdbId);
  if (!detail) return null;
  return buildMeta(detail, kind);
}

/** TMDB id of a title known by its IMDb id (an NFO file or a folder name may carry only that). */
export async function findTmdbIdByImdb(imdbId: string, kind: "movie" | "tv"): Promise<number | null> {
  if (!/^tt\d+$/.test(imdbId)) return null;
  const data = await tmdbGet(`/find/${imdbId}?external_source=imdb_id`);
  const list = kind === "movie" ? data?.movie_results : data?.tv_results;
  return Array.isArray(list) && list[0]?.id ? Number(list[0].id) : null;
}

export interface TmdbCandidate {
  tmdbId: number;
  title: string;
  year: string | null;
  poster: string | null;
  overview: string | null;
}

/** Search results for the admin "Fix match" picker (no scoring: the admin chooses). */
export async function searchTmdbCandidates(kind: "movie" | "tv", query: string, year?: string | null): Promise<TmdbCandidate[]> {
  const results = await search(kind, query, year || undefined);
  const more = year ? await search(kind, query) : [];
  const seen = new Set<number>();
  return [...results, ...more]
    .filter((r: any) => r?.id && !seen.has(r.id) && seen.add(r.id))
    .slice(0, 12)
    .map((r: any) => ({
      tmdbId: r.id,
      title: r.title || r.name || "",
      year: String(r.release_date || r.first_air_date || "").slice(0, 4) || null,
      poster: r.poster_path ? `${IMG_BASE}/w342${r.poster_path}` : null,
      overview: r.overview || null,
    }));
}

export interface ImageChoice { path: string; width: number; height: number; language: string | null; preview: string }

/** Every poster, backdrop and logo TMDB has for a title (English and textless first), for "Edit images". */
export async function fetchImageChoices(kind: "movie" | "tv", id: number): Promise<{ posters: ImageChoice[]; backdrops: ImageChoice[]; logos: ImageChoice[] }> {
  const data = await tmdbGet(`/${kind}/${id}/images?include_image_language=en,null,hi`);
  const map = (list: any[], previewSize: string): ImageChoice[] =>
    (list || [])
      .filter((i) => i?.file_path)
      .sort((a, b) => Number(b.iso_639_1 === "en" || b.iso_639_1 == null) - Number(a.iso_639_1 === "en" || a.iso_639_1 == null) || (b.vote_average || 0) - (a.vote_average || 0))
      .slice(0, 40)
      .map((i) => ({ path: i.file_path, width: i.width, height: i.height, language: i.iso_639_1 ?? null, preview: `${IMG_BASE}/${previewSize}${i.file_path}` }));
  return { posters: map(data?.posters, "w342"), backdrops: map(data?.backdrops, "w780"), logos: map(data?.logos, "w300") };
}
