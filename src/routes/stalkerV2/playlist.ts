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
export const playlistDomainRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/images/{slug*}",
    handler: async (request, h) => {
      try {
        const { slug } = request.params;

        // This is a poster/logo relay to the active portal, not a general
        // proxy — it's the one route left unauthenticated (an <img src>
        // can't attach a Bearer header or a stream token). Without these
        // checks it becomes an open, unauthenticated GET relay to the
        // portal's entire HTTP surface: no extension check meant any path
        // (e.g. an internal load.php endpoint) could be reached through us,
        // and no traversal/query-string check meant the target path wasn't
        // actually pinned to a real image resource at all.
        if (slug.includes("..") || slug.includes("?") || slug.includes("#")) {
          return h.response({ success: false, message: "Invalid path" }).code(400);
        }
        if (!/\.(png|jpe?g|webp|gif|svg|bmp|ico)$/i.test(slug)) {
          return h.response({ success: false, message: "Not an image" }).code(400);
        }

        const proto = initialConfig.https ? "https" : "http";
        const targetUrl = `${proto}://${initialConfig.hostname}:${initialConfig.port}/${slug}`;
        const response = await fetch(targetUrl);

        if (!response.ok || !response.body) {
          return h
            .response({ success: false, message: "Image not found" })
            .code(404);
        }

        const contentType =
          response.headers.get("content-type") || "image/jpeg";
        const nodeStream = Readable.fromWeb(response.body as any);

        return h
          .response(nodeStream)
          .type(contentType)
          .header("cache-control", "max-age=3600");
      } catch (err) {
        logger.error({ err }, "Piping error");
        return h
          .response({ success: false, error: "An unexpected error occurred." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/playlist-download",
    handler: async (request, h) => {
      const { type } = request.query as { type?: string };
      const origin = getPublicOrigin(request);

      if (type === "vod") {
        const m3u = await getVodM3uV2(origin);
        return h.response(m3u)
          .type("application/vnd.apple.mpegurl")
          .header("Content-Disposition", 'attachment; filename="vod.m3u"');
      } else {
        const m3u = await getM3uV2(origin);
        return h.response(m3u)
          .type("application/vnd.apple.mpegurl")
          .header("Content-Disposition", 'attachment; filename="iptv.m3u"');
      }
    },
  },

];
