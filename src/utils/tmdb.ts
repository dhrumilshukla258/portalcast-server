import axios from "axios";
import { tmdbApiToken } from "@/config/server";
import { stripReleaseNoise } from "@/utils/titleClean";

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
  backdrop: string | null;
  overview: string | null;
  cast: string | null;
  director: string | null;
  trailerKey: string | null;
}

interface Credits {
  cast: string | null;
  director: string | null;
}

async function fetchCredits(kind: "movie" | "tv", id: number): Promise<Credits> {
  const data = await tmdbGet(`/${kind}/${id}/credits`);
  if (!data) return { cast: null, director: null };
  const cast = (data.cast || [])
    .slice(0, 8)
    .map((c: any) => c.name)
    .filter(Boolean)
    .join(", ") || null;
  const directorCrew = (data.crew || []).find((c: any) => c.job === "Director");
  return { cast, director: directorCrew?.name || null };
}

async function fetchTrailerKey(kind: "movie" | "tv", id: number): Promise<string | null> {
  const data = await tmdbGet(`/${kind}/${id}/videos`);
  const videos: any[] = data?.results || [];
  const youtubeTrailers = videos.filter((v) => v.site === "YouTube" && v.type === "Trailer");
  const best = youtubeTrailers.find((v) => v.official) || youtubeTrailers[0];
  return best?.key || null;
}

function buildMeta(r: any, credits: Credits, trailerKey: string | null): TmdbMeta {
  return {
    poster:   r.poster_path   ? `${IMG_BASE}/w500${r.poster_path}`        : null,
    backdrop: r.backdrop_path ? `${IMG_BASE}/original${r.backdrop_path}`  : null,
    overview: r.overview || null,
    cast: credits.cast,
    director: credits.director,
    trailerKey,
  };
}

export async function fetchMovieMeta(name: string, year?: string): Promise<TmdbMeta | null> {
  const q = encodeURIComponent(cleanTitle(name));
  let r: any = null;
  if (year) {
    const data = await tmdbGet(`/search/movie?query=${q}&year=${year}&language=en-US`);
    r = data?.results?.[0];
  }
  if (!r) {
    const data = await tmdbGet(`/search/movie?query=${q}&language=en-US`);
    r = data?.results?.[0];
  }
  if (!r) return null;
  const [credits, trailerKey] = await Promise.all([
    fetchCredits("movie", r.id),
    fetchTrailerKey("movie", r.id),
  ]);
  return buildMeta(r, credits, trailerKey);
}

export async function fetchTVMeta(name: string, year?: string): Promise<TmdbMeta | null> {
  const q = encodeURIComponent(cleanTitle(name));
  let r: any = null;
  if (year) {
    const data = await tmdbGet(`/search/tv?query=${q}&first_air_date_year=${year}&language=en-US`);
    r = data?.results?.[0];
  }
  if (!r) {
    const data = await tmdbGet(`/search/tv?query=${q}&language=en-US`);
    r = data?.results?.[0];
  }
  if (!r) return null;
  const [credits, trailerKey] = await Promise.all([
    fetchCredits("tv", r.id),
    fetchTrailerKey("tv", r.id),
  ]);
  return buildMeta(r, credits, trailerKey);
}
