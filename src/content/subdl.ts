// SubDL (subdl.com): second subtitle source next to OpenSubtitles. Official API with a
// free key (SUBDL_API_KEY; ~2,000 searches and ~50 downloads per day on the free plan).
//
// Safety: SubDL serves each subtitle as a .zip. We download it in memory with a size
// cap, open it in memory, and keep only the first .srt/.vtt TEXT entry (size-capped,
// path never used). Nothing from the archive is written to disk or executed; the text
// is converted to WebVTT and stored in subtitle_files like OpenSubtitles results.

import axios from "axios";
import { unzipSync } from "fflate";
import { subdlApiKey } from "@/config/server";
import { stripReleaseNoise } from "@/content/titleClean";
import { logger } from "@/infra/logger";
import type { SubtitleResult } from "@/content/opensubtitles";

const SEARCH_URL = "https://api.subdl.com/api/v1/subtitles";
const DOWNLOAD_BASE = "https://dl.subdl.com";
const MAX_ZIP_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 3 * 1024 * 1024;
const PATH_RE = /^\/subtitle\/[\w.-]{1,120}\.zip$/;

/** ISO 639-1 -> SubDL language code (uppercase two letters). */
const toSubdlLang = (lang?: string) => (lang || "en").slice(0, 2).toUpperCase();

export function isSubdlEnabled(): boolean {
  return !!subdlApiKey;
}

export function isValidSubdlPath(path: string): boolean {
  return PATH_RE.test(path);
}

export async function searchSubdl(params: {
  title: string;
  year?: string;
  season?: number;
  episode?: number;
  language?: string;
}): Promise<SubtitleResult[]> {
  if (!subdlApiKey) return [];
  const query: Record<string, string> = {
    api_key: subdlApiKey,
    film_name: stripReleaseNoise(params.title),
    type: params.season !== undefined || params.episode !== undefined ? "tv" : "movie",
    languages: toSubdlLang(params.language),
    subs_per_page: "30",
  };
  if (params.year) query.year = params.year;
  if (params.season !== undefined) query.season_number = String(params.season);
  if (params.episode !== undefined) query.episode_number = String(params.episode);
  try {
    const { data } = await axios.get(SEARCH_URL, { params: query, timeout: 8000, headers: { "User-Agent": "PortalCast-Server" } });
    if (!data?.status || !Array.isArray(data.subtitles)) return [];
    return data.subtitles
      .map((s: any): SubtitleResult | null => {
        const url = String(s?.url ?? "");
        if (!isValidSubdlPath(url)) return null;
        return {
          id: `subdl:${url}`,
          fileId: 0,
          downloadId: `subdl:${url}`,
          source: "subdl",
          language: String(s.lang ?? s.language ?? params.language ?? "unknown").toLowerCase(),
          releaseName: String(s.release_name ?? s.name ?? "Subtitle"),
          downloadCount: 0,
        };
      })
      .filter((r: SubtitleResult | null): r is SubtitleResult => r !== null);
  } catch (err: any) {
    logger.error(`[SubDL] search failed for "${params.title}": ${err?.response?.status ?? ""} ${err?.message ?? err}`);
    return [];
  }
}

/** The subtitle text inside a SubDL zip (first .srt/.vtt entry), or null. */
export async function downloadSubdlText(path: string): Promise<string | null> {
  if (!subdlApiKey || !isValidSubdlPath(path)) return null;
  try {
    const res = await axios.get(`${DOWNLOAD_BASE}${path}`, {
      responseType: "arraybuffer",
      timeout: 15000,
      maxContentLength: MAX_ZIP_BYTES,
      maxBodyLength: MAX_ZIP_BYTES,
      headers: { "User-Agent": "PortalCast-Server" },
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return extractSubtitleText(new Uint8Array(res.data));
  } catch (err: any) {
    logger.error(`[SubDL] download failed for ${path}: ${err?.response?.status ?? ""} ${err?.message ?? err}`);
    return null;
  }
}

/** Exported for tests: pick the first subtitle text file from a zip, size-capped. */
export function extractSubtitleText(zip: Uint8Array): string | null {
  let chosen: Uint8Array | null = null;
  try {
    const files = unzipSync(zip, {
      // Decide from the central directory before inflating: text subtitles only, capped.
      filter: (f) => {
        if (chosen) return false;
        const name = f.name.toLowerCase();
        return (name.endsWith(".srt") || name.endsWith(".vtt")) && f.originalSize > 0 && f.originalSize <= MAX_TEXT_BYTES;
      },
    });
    const names = Object.keys(files).sort();
    if (names.length === 0) return null;
    chosen = files[names[0]];
  } catch {
    return null;
  }
  if (!chosen || chosen.length > MAX_TEXT_BYTES) return null;
  // Most subtitles are UTF-8; fall back to Windows-1252 for older files.
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(chosen);
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(chosen) : utf8;
}
