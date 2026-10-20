import { setting } from "@/config/settings";
import axios from "axios";
import { stripReleaseNoise } from "@/content/titleClean";
import { logger } from "@/infra/logger";
import { decryptSecret } from "@/auth/crypto";
import { User } from "@/models/User";

const OS_BASE = "https://api.opensubtitles.com/api/v1";

function headers(bearerToken?: string, apiKey: string = setting<string>("openSubtitlesKey")) {
  return {
    "Api-Key": apiKey,
    "Content-Type": "application/json",
    // OpenSubtitles requires a descriptive User-Agent identifying the app, not a browser UA.
    "User-Agent": "stalker-m3u-server v1.0",
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
  };
}

// Downloads are quota-limited per OpenSubtitles account (20/day free tier, up
// to 1000/day VIP), not per API key — so linked users authenticate with their
// own OpenSubtitles login to draw from their own quota instead of one shared
// pool. The JWT is valid 24h; cached in memory per app-user id and refreshed
// (re-login) on expiry or 401.
interface OSSession {
  token: string;
  baseUrl: string;
  expiresAt: number;
}
const sessionCache = new Map<number, OSSession>();
const SESSION_TTL_MS = 23 * 60 * 60 * 1000; // refresh a little before the real 24h expiry

async function loginOpenSubtitlesUser(username: string, password: string, apiKey: string = setting<string>("openSubtitlesKey")): Promise<OSSession | null> {
  if (!apiKey) return null;
  try {
    const { data } = await axios.post(
      `${OS_BASE}/login`,
      { username, password },
      { headers: headers(undefined, apiKey), timeout: 8000 },
    );
    if (!data?.token) return null;
    return {
      token: data.token,
      baseUrl: data.base_url ? `https://${data.base_url}/api/v1` : OS_BASE,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
  } catch (err: any) {
    logger.error(`[OpenSubtitles] login failed for "${username}": ${err?.response?.status ?? ""} ${err?.response?.data ? JSON.stringify(err.response.data) : err?.message}`);
    return null;
  }
}

// Resolves (and caches) a per-user OpenSubtitles session for a linked account.
// Returns null if the user hasn't linked an account or login fails — callers
// fall back to the shared-key anonymous download in that case.
async function getUserSession(appUserId: number, apiKey: string = setting<string>("openSubtitlesKey")): Promise<OSSession | null> {
  const cached = sessionCache.get(appUserId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const user = await User.findByPk(appUserId);
  if (!user?.openSubtitlesUsername || !user?.openSubtitlesPasswordEnc) return null;

  let password: string;
  try {
    password = decryptSecret(user.openSubtitlesPasswordEnc);
  } catch (err) {
    logger.error(`[OpenSubtitles] failed to decrypt stored credentials for user ${appUserId}: ${err}`);
    return null;
  }

  const session = await loginOpenSubtitlesUser(user.openSubtitlesUsername, password, apiKey);
  if (session) sessionCache.set(appUserId, session);
  return session;
}

export function forgetOpenSubtitlesSession(appUserId: number): void {
  sessionCache.delete(appUserId);
}

export async function linkOpenSubtitlesAccount(username: string, password: string, apiKey: string = setting<string>("openSubtitlesKey")): Promise<{ success: boolean; error?: string }> {
  if (!apiKey) return { success: false, error: "No OpenSubtitles API key: add your own key (free at opensubtitles.com/consumers) or ask the admin to set one" };
  const session = await loginOpenSubtitlesUser(username, password, apiKey);
  if (!session) return { success: false, error: "OpenSubtitles login failed — check username/password" };
  return { success: true };
}

export interface SubtitleResult {
  id: string;
  /** OpenSubtitles file id (0 for other sources). Kept for older clients. */
  fileId: number;
  /** What to pass to /api/v2/subtitles/download?id= ("os:<fileId>" | "subdl:<path>"). */
  downloadId: string;
  source: "opensubtitles" | "subdl";
  language: string;
  releaseName: string;
  downloadCount: number;
}

export async function searchSubtitles(params: {
  title: string;
  year?: string;
  season?: number;
  episode?: number;
  language?: string;
}, apiKey: string = setting<string>("openSubtitlesKey")): Promise<SubtitleResult[]> {
  if (!apiKey) return [];

  const query: Record<string, string> = {
    query: stripReleaseNoise(params.title),
    languages: params.language || "en",
  };
  if (params.year) query.year = params.year;
  if (params.season !== undefined) query.season_number = String(params.season);
  if (params.episode !== undefined) query.episode_number = String(params.episode);

  try {
    const { data } = await axios.get(`${OS_BASE}/subtitles`, {
      headers: headers(undefined, apiKey),
      params: query,
      timeout: 8000,
    });

    const results: any[] = data?.data || [];
    return results
      .map((r: any) => {
        const file = r.attributes?.files?.[0];
        if (!file) return null;
        return {
          id: r.id,
          fileId: file.file_id,
          downloadId: `os:${file.file_id}`,
          source: "opensubtitles",
          language: r.attributes?.language || "unknown",
          releaseName: r.attributes?.release || r.attributes?.files?.[0]?.file_name || "Subtitle",
          downloadCount: r.attributes?.download_count || 0,
        } as SubtitleResult;
      })
      .filter((r): r is SubtitleResult => r !== null)
      .sort((a, b) => b.downloadCount - a.downloadCount);
  } catch (err: any) {
    logger.error(`[OpenSubtitles] search failed for "${params.title}": ${err?.response?.status ?? ""} ${err?.response?.data ? JSON.stringify(err.response.data) : err?.message}`);
    return [];
  }
}

// OpenSubtitles gates actual file downloads behind a POST that returns a temporary,
// rate-limited download link — this isn't the final .srt content itself.
// `appUserId`, when provided, draws from that user's own linked OpenSubtitles
// account/quota instead of the shared anonymous (API-key-only) pool.
export async function resolveSubtitleDownloadUrl(fileId: number, appUserId?: number, apiKey: string = setting<string>("openSubtitlesKey")): Promise<string | null> {
  if (!apiKey) return null;

  const session = appUserId !== undefined ? await getUserSession(appUserId, apiKey) : null;
  const base = session?.baseUrl || OS_BASE;

  try {
    const { data } = await axios.post(
      `${base}/download`,
      { file_id: fileId },
      { headers: headers(session?.token, apiKey), timeout: 8000 },
    );
    return data?.link || null;
  } catch (err: any) {
    // A cached session token may have expired server-side early or been
    // revoked — drop it and retry once anonymously rather than fail outright.
    if (session && err?.response?.status === 401 && appUserId !== undefined) {
      sessionCache.delete(appUserId);
      logger.warn(`[OpenSubtitles] linked session for user ${appUserId} rejected (401) — retrying anonymously`);
      try {
        const { data } = await axios.post(`${OS_BASE}/download`, { file_id: fileId }, { headers: headers(undefined, apiKey), timeout: 8000 });
        return data?.link || null;
      } catch {
        // fall through to the error log below
      }
    }
    logger.error(`[OpenSubtitles] download resolve failed for fileId=${fileId}: ${err?.response?.status ?? ""} ${err?.response?.data ? JSON.stringify(err.response.data) : err?.message}`);
    return null;
  }
}
