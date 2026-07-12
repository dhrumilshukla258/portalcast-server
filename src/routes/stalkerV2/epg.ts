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
export const epgRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/v2/debug/epg",
    handler: async (request, h) => {
      const { id } = request.query as { id?: string };
      if (!id) return h.response({ error: "id required" }).code(400);
      try {
        const epg = await serverManager.getProvider().getEPG(id);
        return h.response({ channelId: id, count: epg?.js?.length ?? 0, programs: epg?.js?.slice(0, 3) });
      } catch (err: any) {
        return h.response({ error: err.message }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/epg",
    handler: async (request, h) => {
      try {
        const cache = await getEpgCache();
        if (cache) return cache;
        return [];
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to retrieve EPG." })
          .code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v2/refresh-epg",
    handler: async (_request, h) => {
      fetchAndCacheEpg().catch((e) => logger.error(`[refresh-epg] ${e}`));
      return h.response({ success: true, message: "EPG refresh started in background." });
    },
  },

];
