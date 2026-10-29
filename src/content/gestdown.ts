// Gestdown (api.gestdown.info): a free, keyless subtitle API for TV episodes (Addic7ed's
// subtitles), the third source next to OpenSubtitles and SubDL. Episodes only: it has no
// films. Results go through /api/v2/subtitles/download like the others (id "gd:<id>") and are
// stored once in subtitle_files, so a subtitle is fetched from Gestdown at most once.

import axios from "axios";
import { stripReleaseNoise } from "@/content/titleClean";
import { logger } from "@/infra/logger";
import type { SubtitleResult } from "@/content/opensubtitles";

const BASE = "https://api.gestdown.info";
const UA = "PortalCast v1";
const ID_RE = /^[A-Za-z0-9]{10,40}$/;
const MAX_TEXT_BYTES = 3 * 1024 * 1024;

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" });

/** "fr" -> "French" (Gestdown names languages in English); English when none is asked. */
function languageName(lang?: string): string {
  const code = String(lang || "en").slice(0, 2).toLowerCase();
  try { return LANGUAGE_NAMES.of(code) || "English"; } catch { return "English"; }
}

const norm = (s: string) => stripReleaseNoise(s).toLowerCase().replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export function isValidGestdownId(id: string): boolean {
  return ID_RE.test(id);
}

/** Episode subtitles for a show by name; [] for films or when nothing matches. */
export async function searchGestdown(params: { title: string; year?: string; season?: number; episode?: number; language?: string }): Promise<SubtitleResult[]> {
  if (params.season == null || params.episode == null) return [];
  try {
    const found = await axios.get(`${BASE}/shows/search/${encodeURIComponent(stripReleaseNoise(params.title).slice(0, 100))}`, { headers: { "User-Agent": UA }, timeout: 8000 });
    const shows: { id: string; name: string }[] = (found.data?.shows ?? []).filter((s: any) => ID_RE.test(String(s?.id)));
    const want = norm(params.title);
    // The show whose name is the title (a year in the name, "Dark (2017)", is ignored).
    const withYear = params.year ? shows.find((s) => norm(s.name) === want && s.name.includes(params.year!)) : undefined;
    const show = withYear ?? shows.find((s) => norm(s.name) === want);
    if (!show) return [];
    const res = await axios.get(`${BASE}/subtitles/get/${show.id}/${params.season}/${params.episode}/${encodeURIComponent(languageName(params.language))}`,
      { headers: { "User-Agent": UA }, timeout: 8000, validateStatus: (s) => s === 200 || s === 404 });
    if (res.status !== 200) return [];
    return (res.data?.matchingSubtitles ?? [])
      .filter((s: any) => s?.completed && ID_RE.test(String(s.subtitleId)))
      .map((s: any): SubtitleResult => ({
        id: `gd:${s.subtitleId}`,
        fileId: 0,
        downloadId: `gd:${s.subtitleId}`,
        source: "gestdown",
        language: String(params.language || "en"),
        releaseName: [res.data?.episode?.show, s.version, s.hearingImpaired ? "HI" : ""].filter(Boolean).join(" · "),
        downloadCount: Number(s.downloadCount) || 0,
      }))
      .sort((a: SubtitleResult, b: SubtitleResult) => b.downloadCount - a.downloadCount);
  } catch (e: any) {
    logger.warn(`[gestdown] search failed: ${e?.message ?? e}`);
    return [];
  }
}

/** The subtitle file's text (SRT), or null. */
export async function downloadGestdownText(id: string): Promise<string | null> {
  if (!isValidGestdownId(id)) return null;
  const res = await axios.get(`${BASE}/subtitles/download/${id}`, {
    headers: { "User-Agent": UA }, timeout: 15000, responseType: "text", maxContentLength: MAX_TEXT_BYTES, validateStatus: () => true,
  });
  return res.status >= 200 && res.status < 300 ? String(res.data) : null;
}
