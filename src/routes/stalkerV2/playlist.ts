import { cachedRelayImage } from "@/content/imageCache";
import { countOutbound, noteOutboundResult } from "@/services/outboundTraffic";
import { ServerRoute } from "@hapi/hapi";
import { sniffImage, mimeOf, svgHeaders, type ImageKind } from "@/infra/sniffImage";
import { recordFromRequest } from "@/services/SecurityEvents";
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
import { channelLogoPath, proxiedLogoPath, verifyImageProxySignature } from "@/providers/portalAssets";
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

// Relayed images are buffered (posters/logos are small) so their real type can be read
// from the bytes. Anything over the cap or not an image is refused.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
async function readImageBody(response: Response): Promise<{ buf: Buffer; kind: ImageKind } | null> {
  const len = Number(response.headers.get("content-length") || 0);
  if (len > MAX_IMAGE_BYTES) return null;
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) return null;
  const kind = sniffImage(buf);
  return kind ? { buf, kind } : null;
}
function imageResponse(h: any, img: { buf: Buffer; kind: ImageKind }) {
  // Kept 30 days by the apps: a portal image at a given address practically never changes,
  // and every reload used to go back through us to the portal after an hour.
  const r = h.response(img.buf).type(mimeOf(img.kind)).header("cache-control", "public, max-age=2592000");
  if (img.kind === "svg") for (const [k, v] of Object.entries(svgHeaders)) r.header(k, v);
  return r;
}

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
        // Kept by the server after the first fetch (content/imageCache.ts cachedRelayImage).
        const buf = await cachedRelayImage(targetUrl, async () => {
          countOutbound(targetUrl, undefined, "portal image");
          const response = await fetch(targetUrl);
          noteOutboundResult(targetUrl, true);
          if (!response.ok || !response.body) return null;
          // Served by what the bytes are, not by what the portal claims (or the extension).
          const img = await readImageBody(response);
          if (!img) recordFromRequest(request, "image_proxy_blocked", `portal path ${slug.slice(0, 80)} is not an image`);
          return img?.buf ?? null;
        });
        const kind = buf ? sniffImage(buf) : null;
        if (!buf || !kind) {
          return h
            .response({ success: false, message: "Image not found" })
            .code(404);
        }
        return imageResponse(h, { buf, kind });
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
      const { u, s } = request.query as { u?: string; s?: string };
      if (!u) return h.response({ success: false, message: "Missing u" }).code(400);
      if (!verifyImageProxySignature(u, s)) {
        recordFromRequest(request, "image_proxy_blocked", "unsigned or tampered image URL");
        return h.response({ success: false, message: "Forbidden" }).code(403);
      }

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
        // Kept by the server after the first fetch (content/imageCache.ts cachedRelayImage).
        let forbiddenRedirect = false;
        const buf = await cachedRelayImage(targetUrl, async () => {
          countOutbound(targetUrl, undefined, "image proxy");
          let response = await fetchPinnedImage(targetUrl);
          for (let redirects = 0; response.status >= 300 && response.status < 400 && redirects < 5; redirects++) {
            const location = response.headers.get("location");
            if (!location) break;
            const nextUrl = new URL(location, targetUrl);
            if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
              forbiddenRedirect = true;
              return null;
            }
            response = await fetchPinnedImage(nextUrl.toString());
          }
          if (!response.ok || !response.body) {
            logger.warn(`[images/proxy] upstream ${parsed.hostname} returned ${response.status}`);
            return null;
          }
          // Served by what the bytes are, not by the upstream's Content-Type.
          const img = await readImageBody(response);
          if (!img) {
            recordFromRequest(request, "image_proxy_blocked", `${parsed.hostname} returned a non-image`);
            logger.warn(`[images/proxy] ${parsed.hostname} sent a non-image for ${parsed.pathname}`);
          }
          return img?.buf ?? null;
        });
        if (forbiddenRedirect) return h.response({ success: false, message: "Forbidden redirect" }).code(403);
        const kind = buf ? sniffImage(buf) : null;
        if (!buf || !kind) return h.response({ success: false, message: "Image not found" }).code(404);
        return imageResponse(h, { buf, kind });
      } catch (err) {
        if (err instanceof ForbiddenHostError) {
          recordFromRequest(request, "image_proxy_blocked", parsed.hostname);
          logger.warn(`[images/proxy] ${err.message} (resolves to a private/loopback address)`);
          return h.response({ success: false, message: "Forbidden host" }).code(403);
        }
        logger.error({ err }, "Image proxy fetch error");
        return h.response({ success: false, message: "Fetch failed" }).code(502);
      }
    },
  },
];
