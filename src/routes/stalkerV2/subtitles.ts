import { ServerRoute } from "@hapi/hapi";
import { toVtt } from "@/content/subtitleText";
import { SubtitleFile } from "@/models/SubtitleFile";
import {
  writeJSON,
  readChannels,
  writeChannels,
  readGenres,
  writeGenres,
  upsertGenres,
} from "@/infra/storage";
import { initialConfig, seriesFlag } from "@/config/server";
import { serverManager } from "@/serverManager";
import axios from "axios";
import { ConfigProfile } from "@/models/ConfigProfile";
import { ContentCache } from "@/models/ContentCache";
import { stalkerApi } from "@/providers/stalker";
import { Readable } from "stream";
import { XtreamCache } from "@/models/XtreamCache";
import { ContentOverride } from "@/models/ContentOverride";
import { warmVodCache, warmSeriesCache, warmSeriesInfoCache, cleanupGenres, catchupScan, xtreamCache, getOrRefreshVodStreams, getOrRefreshSeriesList } from "@/services/xtreamCache";
import { logger } from "@/infra/logger";
import { authCheck } from "@/auth/jwt";
import { mintStreamToken, proxyUrlFor, streamTokenFromRequest } from "@/services/StreamTokens";
import {
  applyGenreOverrides,
  applyChannelOverrides,
  applyPortalItemOverrides,
} from "@/content/overrides";
import { mintDownloadToken, DownloadPayload } from "@/services/downloadTokens";
import crypto from "crypto";
import { getEpgCache, fetchAndCacheEpg } from "@/content/epg";
import { getPublicOrigin } from "@/infra/publicUrl";
import { channelLogoPath, proxiedLogoPath } from "@/providers/portalAssets";
import { fetchMovieMeta, fetchTVMeta } from "@/content/tmdb";
import { searchSubtitles, resolveSubtitleDownloadUrl, type SubtitleResult } from "@/content/opensubtitles";
import { searchSubdl, downloadSubdlText, isValidSubdlPath } from "@/content/subdl";
import { subtitleKeysFor } from "@/content/subtitleKeys";
import { searchGestdown, downloadGestdownText, isValidGestdownId } from "@/content/gestdown";
import { hashForResource } from "@/content/movieHash";
import { fileForToken } from "@/routes/library/stream";
import { JELLYFIN_ROOT, jellyfinIdsOf, jellyfinSubtitleSearch, jellyfinSubtitleText } from "@/content/library/jellyfin";
import {
  streamUserLabel,
  CACHE_DURATION_MS,
  resolveStalkerUrl,
  resolveHlsSegmentUrls,
  streamHlsSegments,
  enrichArtworkFromTmdb,
  getActiveProfileId,
  generateCacheKey,
  mapChannel,
} from "./shared";
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const searchCache = new Map<string, { at: number; results: unknown[] }>();

export const subtitleRoutes: ServerRoute[] = [
  {
    // Searches every source in parallel (OpenSubtitles, SubDL, and Gestdown for episodes) and
    // merges: OpenSubtitles first by popularity, then SubDL, then Gestdown. Each result carries `downloadId`.
    method: "GET",
    path: "/api/v2/subtitles/search",
    handler: async (request, h) => {
      try {
        const { title, year, season, episode, lang } = request.query as {
          title?: string; year?: string; season?: string; episode?: string; lang?: string;
        };
        // `t`: the stream token of what is playing (apps from 2026-10-29). It gives the file's
        // hash (exact matches first) and, for a Jellyfin file, Jellyfin's own subtitle search.
        const playing = (request.query as any).t ? streamTokenFromRequest(request) : null;
        if (!title || title.length > 200) return h.response({ error: "Missing or too long title" }).code(400);
        for (const v of [year, season, episode]) if (v !== undefined && !/^\d{1,4}$/.test(String(v))) return h.response({ error: "Invalid number" }).code(400);
        if (lang !== undefined && !/^[a-z]{2,3}(-[a-z]{2})?$/i.test(String(lang))) return h.response({ error: "Invalid language" }).code(400);

        // Same query from any client within 24 h is answered from memory (saves API calls).
        // Only non-empty answers are cached, so a user who adds a key gets results right away.
        const moviehash = playing ? await hashForResource(playing.resource) : null;
        const jfFile = playing?.resource?.startsWith("local:") ? (await fileForToken(playing.resource))?.file : null;
        const jfItem = jfFile?.root === JELLYFIN_ROOT ? jellyfinIdsOf(jfFile.relPath)?.itemId ?? null : null;
        const key = JSON.stringify([title.trim().toLowerCase(), year ?? "", season ?? "", episode ?? "", lang ?? "", moviehash ?? "", jfItem ?? ""]);
        const hit = searchCache.get(key);
        if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return { success: true, results: hit.results };

        const params = {
          title,
          year,
          season: season ? Number(season) : undefined,
          episode: episode ? Number(episode) : undefined,
          language: lang,
          moviehash,
        };
        const caller = authCheck(request);
        const keys = await subtitleKeysFor(caller ? caller.userId : undefined);
        const fromJellyfin = async (): Promise<SubtitleResult[]> => {
          if (!jfItem) return [];
          try {
            return (await jellyfinSubtitleSearch(jfItem, lang)).map((s) => ({
              id: `jfsub:${s.id}`, fileId: 0, downloadId: `jfsub:${s.id}`, source: "jellyfin", language: lang || "en",
              releaseName: `${s.name} · ${s.provider}`, downloadCount: s.downloads, exactMatch: s.exact,
            }));
          } catch (e: any) {
            logger.warn(`[subtitles] Jellyfin's subtitle search failed: ${e?.message ?? e}`);
            return [];
          }
        };
        const [os, subdl, gd, jf] = await Promise.all([searchSubtitles(params, keys.openSubtitles), searchSubdl(params, keys.subdl), searchGestdown(params), fromJellyfin()]);
        // Made for this exact file first, wherever they come from; then each source in turn,
        // Jellyfin's first (owner 2026-10-29: Jellyfin's subtitles come first).
        const all: SubtitleResult[] = [...jf, ...os, ...subdl, ...gd];
        const results = [...all.filter((r) => r.exactMatch), ...all.filter((r) => !r.exactMatch)];
        if (results.length > 0) {
          searchCache.set(key, { at: Date.now(), results });
          if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value as string);
        }
        return { success: true, results };
      } catch (err) {
        logger.error({ err }, "Subtitle search error");
        return h.response({ success: false, error: "Subtitle search failed." }).code(500);
      }
    },
  },

  {
    // ?id=os:<fileId> | subdl:/subtitle/<x>.zip | gd:<id>   (older clients: ?fileId=<n>)
    method: "GET",
    path: "/api/v2/subtitles/download",
    handler: async (request, h) => {
      try {
        const q = request.query as { id?: string; fileId?: string };
        const id = q.id ?? (q.fileId ? `os:${q.fileId}` : "");
        const osMatch = /^os:(\d{1,12})$/.exec(id);
        const subdlPath = id.startsWith("subdl:") ? id.slice("subdl:".length) : null;
        const gestdownId = id.startsWith("gd:") ? id.slice(3) : null;
        const jellyfinSub = id.startsWith("jfsub:") ? id.slice(6) : null;
        if (!osMatch && !(subdlPath && isValidSubdlPath(subdlPath)) && !(gestdownId && isValidGestdownId(gestdownId)) && !(jellyfinSub && /^[\w.:-]{1,200}$/.test(jellyfinSub))) {
          return h.response({ error: "Missing or invalid subtitle id" }).code(400);
        }

        // Already fetched once: serve the stored copy, spending no download quota.
        const stored = await SubtitleFile.findByPk(id);
        if (stored) return h.response(stored.vtt).header("Content-Type", "text/vtt; charset=utf-8");

        let text: string | null = null;
        if (osMatch) {
          // Draws from the caller's own linked OpenSubtitles quota when they have one,
          // falling back to the shared API-key-only pool.
          const userPayload = authCheck(request);
          const uid = userPayload ? userPayload.userId : undefined;
          const keys = await subtitleKeysFor(uid);
          const link = await resolveSubtitleDownloadUrl(Number(osMatch[1]), uid, keys.openSubtitles);
          if (!link) return h.response({ error: "Failed to resolve subtitle download link" }).code(502);
          const response = await axios({ method: "get", url: link, responseType: "text", validateStatus: () => true, maxContentLength: 5 * 1024 * 1024 });
          if (response.status >= 200 && response.status < 300) text = String(response.data);
        } else if (subdlPath) {
          const caller = authCheck(request);
          text = await downloadSubdlText(subdlPath, (await subtitleKeysFor(caller ? caller.userId : undefined)).subdl);
        } else if (gestdownId) {
          text = await downloadGestdownText(gestdownId);
        } else if (jellyfinSub) {
          text = await jellyfinSubtitleText(jellyfinSub).catch(() => null);
        }
        if (!text || !text.trim()) return h.response({ error: "Subtitle download failed" }).code(502);

        const vtt = toVtt(text);
        if (!vtt) {
          logger.warn(`[subtitles] ${id}: provider returned something that is not a subtitle file`);
          return h.response({ error: "That file is not a subtitle" }).code(502);
        }
        await SubtitleFile.upsert({ key: id, vtt }).catch((e: any) =>
          logger.warn(`[subtitles] could not store ${id}: ${e?.message ?? e}`));
        return h.response(vtt).header("Content-Type", "text/vtt; charset=utf-8");
      } catch (err) {
        logger.error({ err }, "Subtitle download error");
        return h.response({ success: false, error: "Subtitle download failed." }).code(500);
      }
    },
  },
];
