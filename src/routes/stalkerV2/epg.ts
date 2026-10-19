import { ServerRoute, Request, ResponseToolkit } from "@hapi/hapi";
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
import { getEpgSnapshot, getWindow, getWindowForIds, parseWindowHours, windowBounds, etagMatches } from "@/content/epgServe";
import zlib from "zlib";
import { getPublicOrigin } from "@/infra/publicUrl";
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
// Sends a prebuilt gzip JSON body: as-is (Content-Encoding: gzip) when the client accepts gzip,
// gunzipped otherwise; 304 when If-None-Match matches. `etag` is a weak tag (W/"...").
function sendBody(request: Request, h: ResponseToolkit, gz: Buffer, etag: string) {
  if (etagMatches(request.headers["if-none-match"] as string | undefined, etag)) {
    return h.response().code(304).header("etag", etag).header("vary", "accept-encoding");
  }
  const acceptsGzip = /\bgzip\b/i.test(String(request.headers["accept-encoding"] ?? ""));
  const res = acceptsGzip
    ? h.response(gz).compressed("gzip")
    : h.response(zlib.gunzipSync(gz));
  return res
    .type("application/json; charset=utf-8")
    .header("etag", etag)
    .header("vary", "accept-encoding")
    .header("cache-control", "no-cache");
}

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
    // Whole guide, unchanged shape: `{ timestamp, data: { [channelId]: EPG_List[] } }`, or `[]`
    // when there is no guide younger than 12 h. Served from a prebuilt gzip buffer (see
    // content/epgServe.ts) instead of parse + re-serialise of ~50 MB per request.
    handler: async (request, h) => {
      try {
        const snap = await getEpgSnapshot();
        if (!snap) return [];
        return sendBody(request, h, snap.full.gz, snap.full.etag);
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to retrieve EPG." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/epg/window",
    // Programmes overlapping the next `hours` (default 6, max 24), per channel, sorted by start:
    // `{ timestamp, windowStart, windowEnd, data: { [channelId]: EPG_List[] } }`. The window is
    // hour-aligned: windowStart = start of the current hour, windowEnd = windowStart + (hours+1) h,
    // so one response covers now..now+hours for the whole hour. Channels with no programme in
    // the window are omitted. `ids=1,2,3` restricts it to those channels. ETag + If-None-Match
    // (304) supported. No guide (or one older than 12 h) -> `{ timestamp: null, data: {} }`.
    handler: async (request, h) => {
      try {
        const q = request.query as { hours?: string; ids?: string };
        const hours = parseWindowHours(q.hours);
        const snap = await getEpgSnapshot();
        if (!snap) {
          const [windowStart, windowEnd] = windowBounds(hours);
          return { timestamp: null, windowStart, windowEnd, data: {} };
        }
        const ids = (q.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (ids.length > 0) {
          const { raw, etag } = getWindowForIds(snap, hours, ids);
          if (etagMatches(request.headers["if-none-match"] as string | undefined, etag)) return h.response().code(304).header("etag", etag);
          return h.response(raw).type("application/json; charset=utf-8").header("etag", etag).header("cache-control", "no-cache");
        }
        const win = await getWindow(snap, hours);
        return sendBody(request, h, win.gz, win.etag);
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to retrieve EPG window." })
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
