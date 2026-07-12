import axios from "axios";
import { openSubtitlesApiKey } from "@/config/server";
import { stripReleaseNoise } from "@/content/titleClean";
import { logger } from "@/infra/logger";
import { decryptSecret } from "@/auth/crypto";
import { User } from "@/models/User";

const OS_BASE = "https://api.opensubtitles.com/api/v1";

function headers(bearerToken?: string) {
  return {
    "Api-Key": openSubtitlesApiKey,
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

async function loginOpenSubtitlesUser(username: string, password: string): Promise<OSSession | null> {
  try {
    const { data } = await axios.post(
      `${OS_BASE}/login`,
      { username, password },
      { headers: headers(), timeout: 8000 },
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
async function getUserSession(appUserId: number): Promise<OSSession | null> {
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

  const session = await loginOpenSubtitlesUser(user.openSubtitlesUsername, password);
  if (session) sessionCache.set(appUserId, session);
  return session;
}

export async function linkOpenSubtitlesAccount(username: string, password: string): Promise<{ success: boolean; error?: string }> {
  const session = await loginOpenSubtitlesUser(username, password);
  if (!session) return { success: false, error: "OpenSubtitles login failed — check username/password" };
  return { success: true };
}

export interface SubtitleResult {
  id: string;
  fileId: number;
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
}): Promise<SubtitleResult[]> {
  if (!openSubtitlesApiKey) {
    logger.warn("[OpenSubtitles] OPENSUBTITLES_API_KEY is not set — online subtitle search always returns 0 results");
    return [];
  }

  const query: Record<string, string> = {
    query: stripReleaseNoise(params.title),
    languages: params.language || "en",
  };
  if (params.year) query.year = params.year;
  if (params.season !== undefined) query.season_number = String(params.season);
  if (params.episode !== undefined) query.episode_number = String(params.episode);

  try {
    const { data } = await axios.get(`${OS_BASE}/subtitles`, {
      headers: headers(),
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
export async function resolveSubtitleDownloadUrl(fileId: number, appUserId?: number): Promise<string | null> {
  if (!openSubtitlesApiKey) return null;

  const session = appUserId !== undefined ? await getUserSession(appUserId) : null;
  const base = session?.baseUrl || OS_BASE;

  try {
    const { data } = await axios.post(
      `${base}/download`,
      { file_id: fileId },
      { headers: headers(session?.token), timeout: 8000 },
    );
    return data?.link || null;
  } catch (err: any) {
    // A cached session token may have expired server-side early or been
    // revoked — drop it and retry once anonymously rather than fail outright.
    if (session && err?.response?.status === 401 && appUserId !== undefined) {
      sessionCache.delete(appUserId);
      logger.warn(`[OpenSubtitles] linked session for user ${appUserId} rejected (401) — retrying anonymously`);
      try {
        const { data } = await axios.post(`${OS_BASE}/download`, { file_id: fileId }, { headers: headers(), timeout: 8000 });
        return data?.link || null;
      } catch {
        // fall through to the error log below
      }
    }
    logger.error(`[OpenSubtitles] download resolve failed for fileId=${fileId}: ${err?.response?.status ?? ""} ${err?.response?.data ? JSON.stringify(err.response.data) : err?.message}`);
    return null;
  }
}
