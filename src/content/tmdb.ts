import axios from "axios";
import { tmdbApiToken } from "@/config/server";
import { stripReleaseNoise } from "@/content/titleClean";
import { countryLabel } from "@/content/countryNames";

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE  = "https://image.tmdb.org/t/p";

// Same channel-prefix/quality/language stripping strmGenerator uses to group duplicate
// portal listings — searching TMDB with that same cleaned title gets much better matches
// than the portal's raw (often noisy) name.
function cleanTitle(name: string): string {
  return stripReleaseNoise(name);
}

async function tmdbGet(path: string): Promise<any | null> {
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
    cast: credits.cast,
    director: credits.director,
    trailerKey,
    tmdbId: detail.id,
    genres,
    originalLanguage: detail.original_language || null,
    countries,
    keywordIds: extractKeywordIds(detail, kind),
    releaseYear,
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
  return tmdbGet(
    `/${kind}/${id}?append_to_response=credits,videos,keywords,images&include_image_language=null,en`
  );
}

async function search(kind: "movie" | "tv", query: string, year?: string): Promise<any | null> {
  const q = encodeURIComponent(query);
  const yearParam = kind === "movie"
    ? (year ? `&year=${year}` : "")
    : (year ? `&first_air_date_year=${year}` : "");
  const data = await tmdbGet(`/search/${kind}?query=${q}&language=en-US${yearParam}`);
  return data?.results?.[0] || null;
}

async function fetchMeta(kind: "movie" | "tv", name: string, year?: string): Promise<TmdbMeta | null> {
  const cleaned = cleanTitle(name);
  let r = await search(kind, cleaned, year);
  // Fallback: some portal years are wrong/guessed, causing a false-negative year-filtered
  // search — retry once without the year constraint before giving up.
  if (!r && year) r = await search(kind, cleaned);
  if (!r) return null;

  const detail = await fetchDetail(kind, r.id);
  if (!detail) return null;
  return buildMeta(detail, kind);
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
