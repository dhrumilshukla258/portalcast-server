import { ServerRoute, Request, ResponseToolkit } from "@hapi/hapi";
import { httpClient } from "@/streaming/httpClient";
import http from "http";
import https, { RequestOptions } from "https";
import { initialConfig } from "@/config/server";
import { logger } from "@/infra/logger";
import { streamTracker } from "@/services/StreamTracker";
import { mintStreamToken, streamTokenFromRequest } from "@/services/StreamTokens";
import type { StreamMeta } from "@/services/StreamTracker";

// HLS segment files sit alongside each other in the same directory (e.g.
// .../seg-00001.ts, seg-00002.ts) — dropping the filename gives a stable
// per-stream resource key instead of a new one on every segment request.
function resourceKeyFor(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/[^/]*$/, "");
  } catch {
    return url;
  }
}

function assertHttpUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }
  return u;
}

// Mints an opaque token for a real upstream URL — the client only ever sees
// `/api/proxy/stream?t=<random>`, never the real address (even base64 is
// trivially reversible by anyone who copies the link, which is exactly what
// this replaces).
export function getProxiedUrl(url: string, userLabel: string, referer?: string, meta?: StreamMeta): string {
  const token = mintStreamToken(url, userLabel, referer, meta);
  return `/api/proxy/stream?t=${token}`;
}

export async function handleProxyStream(
  request: any,
  h: any,
  decodedUrl: string,
  referer: string | undefined,
  userLabel: string,
  meta?: StreamMeta,
) {
  const requestHeaders: Record<string, string | undefined> = {
    Referer: referer,
    "User-Agent": "VLC/3.0.16 LibVLC/3.0.16",
    Accept: "*/*",
  };
  if (request.headers.range) {
    requestHeaders["Range"] = request.headers.range;
  }

  streamTracker.touch("proxy", request.info.remoteAddress, resourceKeyFor(decodedUrl), userLabel, meta);

  const response = await httpClient.get(decodedUrl, {
    responseType: "stream",
    headers: requestHeaders,
    timeout: 0,
    validateStatus: () => true,
    skipRetry: true,
  } as any);

  const stream = response.data as http.IncomingMessage;

  // Clean up upstream connection if client aborts/disconnects
  request.raw.req.on("close", () => {
    if (stream && !stream.destroyed) {
      stream.destroy();
    }
  });

  const hapiResponse = h.response(stream).code(response.status);

  const headersToCopy = [
    "content-type",
    "content-length",
    "accept-ranges",
    "content-range",
    "date",
    "last-modified",
    "etag",
  ];

  for (const [key, value] of Object.entries(response.headers)) {
    if (value && headersToCopy.includes(key.toLowerCase())) {
      hapiResponse.header(key, value.toString());
    }
  }

  hapiResponse.header("Access-Control-Allow-Origin", "*");
  hapiResponse.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  hapiResponse.header("Access-Control-Allow-Headers", "Content-Type, Range");

  return hapiResponse;
}

export const proxy: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/proxy/stream",
    handler: async (request, h) => {
      const entry = streamTokenFromRequest(request);
      if (!entry) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        assertHttpUrl(entry.resource);
        logger.info(`[/proxy/stream] ${request.info.remoteAddress} → ${entry.resource}`);
        return await handleProxyStream(request, h, entry.resource, entry.referer, entry.userLabel, entry);
      } catch (error: any) {
        logger.error("[/proxy/stream] error: " + (error?.message ?? error));
        if (error.response) {
          return h
            .response({ error: "Failed to fetch upstream content" })
            .code(error.response.status);
        }
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },

  {
    method: "GET",
    path: "/api/proxy",
    handler: async (request, h) => {
      const entry = streamTokenFromRequest(request);
      if (!entry) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const decodedUrl = entry.resource;
        const referer = entry.referer;
        const userLabel = entry.userLabel;

        // Stalker portal cmds (e.g. "ffrt http://...") — hand off to the live route which handles them properly
        let isHttpUrl = true;
        try { assertHttpUrl(decodedUrl); } catch { isHttpUrl = false; }
        if (!isHttpUrl) {
          const cmdToken = mintStreamToken(decodedUrl, userLabel);
          return h.redirect(`/live.m3u8?t=${cmdToken}`);
        }

        const playlistUrl = assertHttpUrl(decodedUrl).href;
        logger.info(`[/proxy] ${request.info.remoteAddress} → ${playlistUrl}`);

        const u = new URL(playlistUrl);
        const pathLower = u.pathname.toLowerCase();
        const isBinaryExt = [
          ".mp4",
          ".mkv",
          ".ts",
          ".avi",
          ".mov",
          ".flv",
          ".wmv",
          ".m4v",
          ".3gp",
          ".mpg",
          ".mpeg",
          ".m2ts",
          ".mp3",
          ".aac",
          ".m4a",
        ].some((ext) => pathLower.endsWith(ext));

        if (isBinaryExt) {
          return await handleProxyStream(request, h, playlistUrl, referer, userLabel, entry);
        }

        const headers: Record<string, string> = {};
        if (initialConfig.providerType === "xtream") {
          headers["User-Agent"] = "VLC/3.0.16 LibVLC/3.0.16";
        }
        if (referer) headers["Referer"] = referer;

        try {
          const headRes = await httpClient.head(playlistUrl, { headers });
          const contentType = headRes.headers["content-type"] || "";

          if (
            contentType.includes("video/") ||
            contentType.includes("application/octet-stream")
          ) {
            logger.info(`[SmartProxy] Detected binary content (${contentType}), streaming directly.`);
            return await handleProxyStream(request, h, playlistUrl, referer, userLabel, entry);
          }
        } catch (headErr) {
          logger.warn({ err: headErr }, "[SmartProxy] HEAD request failed, falling back to GET");
        }

        const resp = await httpClient.get<string>(playlistUrl, {
          responseType: "text",
          headers,
          timeout: 15000,
        });

        if (resp.status < 200 || resp.status >= 300) {
          return h
            .response({ error: "Failed to fetch stream" })
            .code(resp.status);
        }

        const body = resp.data || "";

        const finalUrl = resp.request?.res?.responseUrl || playlistUrl;

        if (!body.startsWith("#EXTM3U")) {
          return h.response(body).type("text/plain");
        }

        const urlRegex = /(URI="([^"]+)")|((^[^#\n\r].*)$)/gm;

        const rewritten = body.replace(
          urlRegex,
          (match, uriAttribute, uriValue, segmentUrl) => {
            const urlToRewrite = uriValue || segmentUrl;
            if (!urlToRewrite) return match;

            const absolute = new URL(urlToRewrite, finalUrl).href;

            let proxiedUrl: string;

            // Only carry kind/label/category forward — NOT the full resolved
            // `entry`, which still has the *parent* playlist's `resource`.
            // Spreading that wholesale into mintStreamToken's meta would
            // silently overwrite the new segment/sub-playlist URL with the
            // old one (object spread order), making every segment re-fetch
            // the parent playlist instead of real video data.
            const subMeta: StreamMeta = { kind: entry.kind, label: entry.label, category: entry.category };

            if (
              urlToRewrite.endsWith(".m3u8") ||
              urlToRewrite.includes(".m3u8?")
            ) {
              const subToken = mintStreamToken(absolute, userLabel, referer, subMeta);
              proxiedUrl = `/api/proxy?t=${subToken}`;
            } else {
              proxiedUrl = getProxiedUrl(absolute, userLabel, referer, subMeta);
            }

            if (uriValue) {
              return `URI="${proxiedUrl}"`;
            } else {
              return proxiedUrl;
            }
          },
        );

        return h
          .response(rewritten)
          .type("application/vnd.apple.mpegurl")
          .header("Cache-Control", "no-cache");
      } catch (err: any) {
        logger.error("[/proxy] error: " + (err?.message ?? err));
        return h.response({ error: "Failed to proxy playlist" }).code(500);
      }
    },
  },
];
