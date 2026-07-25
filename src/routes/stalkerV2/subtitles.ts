import { ServerRoute } from "@hapi/hapi";
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
import { getM3uV2, getVodM3uV2 } from "@/providers/getM3uUrls";
import { channelLogoPath, proxiedLogoPath } from "@/providers/portalAssets";
import { fetchMovieMeta, fetchTVMeta } from "@/content/tmdb";
import { searchSubtitles, resolveSubtitleDownloadUrl } from "@/content/opensubtitles";
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
export const subtitleRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/v2/subtitles/search",
    handler: async (request, h) => {
      try {
        const { title, year, season, episode, lang } = request.query as {
          title?: string;
          year?: string;
          season?: string;
          episode?: string;
          lang?: string;
        };
        if (!title) return h.response({ error: "Missing title" }).code(400);

        const results = await searchSubtitles({
          title,
          year,
          season: season ? Number(season) : undefined,
          episode: episode ? Number(episode) : undefined,
          language: lang,
        });
        return { success: true, results };
      } catch (err) {
        logger.error({ err }, "Subtitle search error");
        return h.response({ success: false, error: "Subtitle search failed." }).code(500);
      }
    },
  },

  {
    method: "GET",
    path: "/api/v2/subtitles/download",
    handler: async (request, h) => {
      try {
        const { fileId } = request.query as { fileId?: string };
        if (!fileId) return h.response({ error: "Missing fileId" }).code(400);

        // Draws from the caller's own linked OpenSubtitles quota when they
        // have one (see [[skill-user-system]] / opensubtitles.ts), falling
        // back to the shared API-key-only pool otherwise.
        const userPayload = authCheck(request);
        const link = await resolveSubtitleDownloadUrl(Number(fileId), userPayload ? userPayload.userId : undefined);
        if (!link) return h.response({ error: "Failed to resolve subtitle download link" }).code(502);

        const response = await axios({
          method: "get",
          url: link,
          responseType: "text",
          validateStatus: () => true,
        });

        // The player renders subtitle tracks via a plain HTML <track> element, which only
        // understands WebVTT — not SRT (different timestamp separator: "," vs "."). OpenSubtitles
        // only serves .srt, so convert it here rather than touching the player's track handling.
        const vtt = "WEBVTT\n\n" + String(response.data).replace(
          /(\d{2}:\d{2}:\d{2}),(\d{3})/g,
          "$1.$2",
        );

        return h.response(vtt)
          .header("Content-Type", "text/vtt; charset=utf-8")
          .code(response.status);
      } catch (err) {
        logger.error({ err }, "Subtitle download error");
        return h.response({ success: false, error: "Subtitle download failed." }).code(500);
      }
    },
  },


];
