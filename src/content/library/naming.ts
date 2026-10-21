// File and folder names in a local library, read the way Jellyfin reads them
// (https://jellyfin.org/docs/general/server/media/movies/), so an existing Jellyfin library
// works unchanged:
//
//   Inception (2010) [tmdbid-27205]/Inception (2010) - 2160p.mkv
//   Inception (2010)/Inception (2010).en.forced.srt
//   Inception.2010.1080p.BluRay.x264-GROUP.mkv            (scene-style lone file)

import path from "path";

export const VIDEO_EXTS = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".ts", ".m2ts", ".webm", ".wmv", ".mpg", ".mpeg", ".flv", ".3gp"]);
export const SUBTITLE_EXTS = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub"]);

/** Folders Jellyfin treats as extras; never scanned as titles. */
export const EXTRA_DIRS = new Set([
  "behind the scenes", "deleted scenes", "interviews", "featurettes", "scenes", "shorts", "trailers",
  "theme-music", "backdrops", "extras", "other", "samples", "sample", "specials", "@eadir", ".trickplay",
]);
/** File-name suffixes Jellyfin treats as extras. */
const EXTRA_SUFFIX_RE = /[-._ ](trailer|sample|behindthescenes|deleted|deletedscene|featurette|interview|scene|short|extra|other|clip)$/i;

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTS.has(path.extname(name).toLowerCase());
}

export function isExtraFile(name: string): boolean {
  const base = path.basename(name, path.extname(name));
  return base.toLowerCase() === "trailer" || base.toLowerCase() === "sample" || EXTRA_SUFFIX_RE.test(base);
}

export interface ParsedName {
  name: string;
  year: string | null;
  tmdbId: number | null;
  imdbId: string | null;
}

const QUALITY_WORDS =
  /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dv|dolby ?vision|sdr|bluray|blu-ray|bdrip|brrip|web-?dl|webrip|web|hdtv|dvdrip|remux|x264|x265|h\.?264|h\.?265|hevc|avc|av1|10bit|8bit|aac|ac3|eac3|dts(-hd)?|truehd|atmos|ddp?5\.1|5\.1|7\.1|proper|repack|extended|unrated|imax|multi|dual audio)\b/i;

/** Name, year and ids from a folder or file name (extension already removed). */
export function parseTitle(raw: string): ParsedName {
  let s = raw;
  let tmdbId: number | null = null;
  let imdbId: string | null = null;

  // [tmdbid-27205] {tmdb-27205} [imdbid-tt1375666] {imdb-tt1375666}
  const tmdb = s.match(/[[{]\s*tmdb(?:id)?\s*[-=]\s*(\d+)\s*[\]}]/i);
  if (tmdb) tmdbId = Number(tmdb[1]);
  const imdb = s.match(/[[{]\s*imdb(?:id)?\s*[-=]\s*(tt\d+)\s*[\]}]/i);
  if (imdb) imdbId = imdb[1];
  s = s.replace(/[[{][^\]}]*[\]}]/g, " ");

  // "Name (2010)" — the year in brackets is the release year.
  let year: string | null = null;
  const paren = s.match(/\((19\d{2}|20\d{2})\)/);
  if (paren) {
    year = paren[1];
    s = s.slice(0, paren.index);
  } else {
    // Scene style "Name.2010.1080p...": the last plausible year that is not the whole name.
    const dotted = s.replace(/[._]/g, " ");
    const years = [...dotted.matchAll(/(?:^|\s)(19\d{2}|20\d{2})(?=\s|$)/g)];
    const last = years.at(-1);
    if (last && last.index! > 0) {
      year = last[1];
      s = dotted.slice(0, last.index);
    } else {
      s = dotted;
    }
  }

  // Cut at the first quality/release word, then tidy.
  s = s.replace(/[._]/g, " ");
  const q = s.match(QUALITY_WORDS);
  if (q && q.index! > 0) s = s.slice(0, q.index);
  s = s.replace(/\s+-\s*$/, "").replace(/\s{2,}/g, " ").trim();
  return { name: s || raw.trim(), year, tmdbId, imdbId };
}

/**
 * The version label of a file inside a movie folder: what follows the folder's base name
 * ("Inception (2010) - 2160p.mkv" -> "2160p"). Null when the file is just the base name.
 */
export function versionLabelFor(fileBase: string, folderBase: string): string | null {
  if (!fileBase.toLowerCase().startsWith(folderBase.toLowerCase())) return null;
  const rest = fileBase.slice(folderBase.length).replace(/^[\s\-._]+/, "").replace(/^\[(.*)\]$/, "$1").trim();
  return rest || null;
}

/** Language and "forced" from a subtitle file name: "Movie.en.forced.srt" -> en, forced. */
export function parseSubtitleName(fileName: string, videoBase: string): { language: string | null; forced: boolean } | null {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  if (!base.toLowerCase().startsWith(videoBase.toLowerCase())) return null;
  const tags = base.slice(videoBase.length).split(/[._\s-]+/).map((t) => t.toLowerCase()).filter(Boolean);
  const forced = tags.includes("forced");
  const language = tags.find((t) => /^[a-z]{2,3}(-[a-z]{2})?$/.test(t) && t !== "sdh" && t !== "cc" && t !== "hi") ?? null;
  return { language, forced };
}

/** Ids and title from a Kodi/Jellyfin NFO file (only what matching needs). */
export function parseNfo(xml: string): { title: string | null; year: string | null; tmdbId: number | null; imdbId: string | null } {
  const tag = (name: string) => xml.match(new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`, "i"))?.[1] ?? null;
  const unique = (type: string) =>
    xml.match(new RegExp(`<uniqueid[^>]*type=["']${type}["'][^>]*>\\s*([^<]+?)\\s*</uniqueid>`, "i"))?.[1] ?? null;
  const tmdbRaw = unique("tmdb") ?? tag("tmdbid");
  const imdbRaw = unique("imdb") ?? tag("imdbid") ?? tag("id");
  const year = tag("year") ?? tag("premiered")?.slice(0, 4) ?? null;
  return {
    title: tag("title"),
    year: year && /^\d{4}$/.test(year) ? year : null,
    tmdbId: tmdbRaw && /^\d+$/.test(tmdbRaw) ? Number(tmdbRaw) : null,
    imdbId: imdbRaw && /^tt\d+$/.test(imdbRaw) ? imdbRaw : null,
  };
}

// ---- Series --------------------------------------------------------------------------
//   The Office (2005)/Season 01/The Office S01E02 - Diversity Day.mkv
//   Friends/Season 1/Friends - 1x02 - The One with the Sonogram.mkv
//   Show/Specials/Show S00E01.mkv                (season 0)
//   Show/Season 2/E05.mkv  or  Show/Season 2/05 - Title.mkv  (season from the folder)

const SEASON_DIR_RE = /^(?:season|series|staffel|saison|temporada|stagione)[\s._-]*(\d{1,3})$/i;

/** The season a folder stands for ("Season 01" -> 1, "Specials" -> 0), or null. */
export function seasonFromFolder(name: string): number | null {
  const n = name.trim();
  if (/^(specials?|extras? season|season[\s._-]*0+)$/i.test(n)) return 0;
  const m = n.match(SEASON_DIR_RE) ?? n.match(/^s(\d{1,3})$/i);
  return m ? Number(m[1]) : null;
}

export interface ParsedEpisode {
  season: number | null;
  episode: number;
  episodeEnd: number | null;
  title: string | null;
}

function tidyEpisodeTitle(rest: string): string | null {
  let s = rest.replace(/^[\s._\-–:]+/, "");
  if (!/\s/.test(s)) s = s.replace(/[._]/g, " ");
  const q = s.match(QUALITY_WORDS);
  if (q && q.index! >= 0) s = s.slice(0, q.index);
  s = s.replace(/[\s._\-–]+$/, "").replace(/\s{2,}/g, " ").trim();
  return s && !/^\d+$/.test(s) ? s : null;
}

/** Season and episode from an episode file name (extension removed). */
export function parseEpisode(fileBase: string, seasonHint: number | null): ParsedEpisode | null {
  // S01E02, S01E02E03, S01E02-E03, s1e2
  let m = fileBase.match(/\bS(\d{1,3})[\s._-]?E(\d{1,4})(?:[\s._-]?(?:-|E)[\s._-]?E?(\d{1,4}))?/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]), episodeEnd: m[3] ? Number(m[3]) : null, title: tidyEpisodeTitle(fileBase.slice(m.index! + m[0].length)) };
  // 1x02, 01x02-03
  m = fileBase.match(/\b(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?\b/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]), episodeEnd: m[3] ? Number(m[3]) : null, title: tidyEpisodeTitle(fileBase.slice(m.index! + m[0].length)) };
  if (seasonHint === null) return null;
  // Inside a season folder: "E05", "Ep 5", "Episode 5", or a leading number "05 - Title".
  m = fileBase.match(/\b(?:E|Ep|Episode)[\s._-]?(\d{1,4})\b/i);
  if (m) return { season: seasonHint, episode: Number(m[1]), episodeEnd: null, title: tidyEpisodeTitle(fileBase.slice(m.index! + m[0].length)) };
  m = fileBase.match(/^(\d{1,3})(?=[\s._-]|$)/);
  if (m) return { season: seasonHint, episode: Number(m[1]), episodeEnd: null, title: tidyEpisodeTitle(fileBase.slice(m[0].length)) };
  return null;
}
