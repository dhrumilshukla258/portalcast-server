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
import dns from "dns";
import net from "net";
import { Agent } from "undici";
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

// SSRF guard for /api/images/proxy — blocks anything resolving to a
// non-routable/internal address (RFC1918, loopback, link-local, unique-local
// IPv6) so a caller-supplied absolute image URL can never be used to reach
// this container's internal network.
function isPrivateOrLoopbackAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return true; // Unrecognized address shape — fail closed.
}

class ForbiddenHostError extends Error {}

// Resolves `hostname` once, rejects private/loopback/link-local results, and
// pins the actual TCP connection to that validated address via undici's
// `lookup` override — so the IP that was checked is guaranteed to be the IP
// that gets connected to, closing the DNS-rebinding/TOCTOU gap that a plain
// dns.lookup() + fetch(url) combo leaves open. `redirect: "manual"` so the
// caller can re-validate each hop instead of trusting fetch's own follow.
async function fetchPinnedImage(targetUrl: string): Promise<Response> {
  const parsed = new URL(targetUrl);
  const { address, family } = await dns.promises.lookup(parsed.hostname);
  if (isPrivateOrLoopbackAddress(address)) {
    throw new ForbiddenHostError(`Forbidden host: ${parsed.hostname}`);
  }

  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, [{ address, family, ttl: -1 } as any]);
      },
    },
  });

  return fetch(targetUrl, { redirect: "manual", dispatcher } as any);
}

export const playlistDomainRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/images/{slug*}",
    handler: async (request, h) => {
      try {
        const slug = request.params.slug as string;

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
    // Companion to the slug-based relay above, for images that live at a full
    // absolute upstream URL rather than a portal-root-relative path (Xtream
    // stream_icon/cover fields, or any already-absolute Stalker logo). `u` is
    // just base64url of the target URL — not a secret token, purely so the raw
    // host string never appears in the page's own HTML/DOM (see portalAssets.ts'
    // proxiedImageUrl). Since the target host is caller-controlled, this must
    // never become an open SSRF relay: resolve it first and refuse anything
    // that lands on a private/loopback/link-local address.
    method: "GET",
    path: "/api/images/proxy",
    handler: async (request, h) => {
      const { u } = request.query as { u?: string };
      if (!u) return h.response({ success: false, message: "Missing u" }).code(400);

      let targetUrl: string;
      let parsed: URL;
      try {
        targetUrl = Buffer.from(u, "base64url").toString("utf8");
        parsed = new URL(targetUrl);
      } catch {
        return h.response({ success: false, message: "Invalid url" }).code(400);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return h.response({ success: false, message: "Invalid protocol" }).code(400);
      }

      try {
        // Resolve, validate, and fetch through a pinned connection so the
        // address we checked is the address we actually connect to — fetch()
        // performing its own independent DNS resolution (or silently
        // following a redirect to an unchecked host) would reopen the SSRF
        // this guard exists to close.
        let response = await fetchPinnedImage(targetUrl);
        for (let redirects = 0; response.status >= 300 && response.status < 400 && redirects < 5; redirects++) {
          const location = response.headers.get("location");
          if (!location) break;
          const nextUrl = new URL(location, targetUrl);
          if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
            return h.response({ success: false, message: "Forbidden redirect" }).code(403);
          }
          response = await fetchPinnedImage(nextUrl.toString());
        }

        if (!response.ok || !response.body) {
          return h.response({ success: false, message: "Image not found" }).code(404);
        }
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) {
          return h.response({ success: false, message: "Not an image" }).code(400);
        }
        const nodeStream = Readable.fromWeb(response.body as any);
        return h
          .response(nodeStream)
          .type(contentType)
          .header("cache-control", "max-age=3600");
      } catch (err) {
        if (err instanceof ForbiddenHostError) {
          return h.response({ success: false, message: "Forbidden host" }).code(403);
        }
        logger.error({ err }, "Image proxy fetch error");
        return h.response({ success: false, message: "Fetch failed" }).code(502);
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
