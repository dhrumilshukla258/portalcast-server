import { cmdPlayerV2 } from "@/streaming/cmdPlayer";
import axios, { AxiosError, AxiosResponse } from "axios";
import { ServerRoute } from "@hapi/hapi";
import { http, https } from "follow-redirects";
import { RequestOptions } from "https";
import NodeCache from "node-cache";
import { initialConfig } from "@/config/server";
import { ReqRefDefaults, ResponseToolkit } from "@hapi/hapi/lib/types";
import { stalkerApi } from "@/providers/stalker";
import { logger } from "@/infra/logger";
import { streamTracker, type StreamMeta } from "@/services/StreamTracker";
import { mintOrReuseStreamToken, streamTokenFromRequest, resolveStreamToken } from "@/services/StreamTokens";
import { segmentKey, primeSegment, readSegment, type CachedSegment } from "@/services/segmentCache";

const sequenceRegex = /#EXT-X-MEDIA-SEQUENCE:(\d+)/;

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// Mints an opaque token mapping to resourceId ("cmd<_>seq") + identity — the
// client only ever sees /player/{token}.ts, never the real cmd. Reuses the
// same token across repeated playlist polls for the same segment — hls.js
// correlates segments between two overlapping live playlists by sequence
// number and requires their URLs to match, so a fresh token per poll for an
// unchanged segment reads to it as a fatal "media sequence mismatch".
function generateSignedUrl(resourceId: string, userLabel: string, meta?: StreamMeta): string {
  const token = mintOrReuseStreamToken(resourceId, userLabel, undefined, meta);
  return `/player/${token}.ts`;
}

interface CacheRecord {
  baseUrl: string;
  segments: Map<number, string>;
  subpath?: string;
  masterUrl?: string;
}

const cache = new NodeCache({ stdTTL: 600, checkperiod: 60 });

// ── Segment read-ahead + shared cache ───────────────────────────────────────
// When a segment is served, the next one is prefetched in the background so the
// browser's next request is answered from memory instead of paying the full
// portal round-trip — the main cause of stutter through the proxy. This now
// also doubles as a SHARED cache across viewers (via src/services/segmentCache.ts):
// `cmd` is identical for every viewer of a given channel, so a segment fetched
// for one viewer is reusable by any other viewer requesting the same sequence
// number — reads no longer delete the entry, unlike the old per-file cache.
async function fetchSegmentBuffer(url: string): Promise<CachedSegment | undefined> {
  const res = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 25_000 });
  return {
    data: Buffer.from(res.data as any),
    contentType: String(res.headers["content-type"] || "video/mp2t"),
  };
}

function prefetchNextSegment(cmd: string, nextSeq: number, record: CacheRecord): void {
  const segPath = record.segments.get(nextSeq);
  if (!segPath) return;
  const key = segmentKey(cmd, nextSeq);
  const url = new URL(segPath, record.baseUrl).href;
  primeSegment(key, () => fetchSegmentBuffer(url));
}

const pendingCommands = new Map<string, Promise<void>>();

async function populateCache(cmd: string): Promise<void> {
  if (pendingCommands.has(cmd)) {
    await pendingCommands.get(cmd);
    return;
  }

  const initCache = async () => {
    const masterUrl = await cmdPlayerV2(cmd);
    if (!masterUrl) throw new Error("Stream Not Found");

    const masterRes = await axios.get(masterUrl, {
      headers: { "User-Agent": "VLC/3.0.18" },
      timeout: 5000
    });

    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);
    const lines = masterRes.data.split("\n");

    let subpath = lines.find(
      (l: string) => l.includes(".m3u8") && !l.startsWith("#"),
    );

    if (!subpath) throw new Error("No Sub-playlist found in Master");

    const subUrl = new URL(subpath, baseUrl).href;
    const mediaRes = await axios.get(subUrl, {
      headers: { "User-Agent": "VLC/3.0.18" },
    });

    const finalBaseUrl = subUrl.substring(0, subUrl.lastIndexOf("/") + 1);

    const seqMatch = mediaRes.data.match(sequenceRegex);
    let currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;

    const segments = new Map<number, string>();
    mediaRes.data.split("\n").forEach((line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      segments.set(currentSeq, trimmed);
      currentSeq++;
    });

    logger.info(
      `Successfully cached ${segments.size} segments. Start Seq: ${seqMatch ? seqMatch[1] : 0}`,
    );
    cache.set(cmd, { baseUrl: finalBaseUrl, segments, subpath, masterUrl } as CacheRecord);
  };

  const promise = initCache().finally(() => {
    pendingCommands.delete(cmd);
  });

  pendingCommands.set(cmd, promise);
  await promise;
}

async function handleProxy(cmd: string, play: string | undefined, h: any, userLabel: string, meta?: StreamMeta) {
  try {
    if (!cache.get(cmd)) {
      await populateCache(cmd);
    }
    const record: CacheRecord | undefined = cache.get(cmd);
    if (!record) {
      return h.response("Stream Not Found").code(404);
    }

    const fetchPlaylist = async (url: string, isSubpath: boolean = false) => {
      const res = await axios.get(url, { validateStatus: () => true, timeout: 15_000 });

      if (!isSubpath && [301, 302, 403].includes(res.status)) {
        const newMasterUrl = await cmdPlayerV2(cmd);
        logger.info(`Refreshed Master URL: ${newMasterUrl}`);

        if (newMasterUrl) {
          const newBaseUrl = newMasterUrl.substring(
            0,
            newMasterUrl.lastIndexOf("/") + 1,
          );
          if (record) {
            record.baseUrl = newBaseUrl;
            record.masterUrl = newMasterUrl;
            cache.set(cmd, record as CacheRecord);
          }
          return await axios.get(newMasterUrl, { validateStatus: () => true });
        }
      }
      if (res.status < 200 || res.status >= 300 || !res.data) {
        return h
          .response({ error: `Upstream Error ${res.status}` })
          .code(res.status);
      }
      return res;
    };

    if (play === "1" && record.subpath) {
      const subUrl = new URL(record.subpath, record.baseUrl).href;
      let res = await fetchPlaylist(subUrl, true);

      if ((res as any).isBoom) return res;

      if (!res.data || res.status === 403) {
        const newMasterUrl = await cmdPlayerV2(cmd);
        if (!newMasterUrl)
          return h.response({ error: "Stream Not Found" }).code(404);

        const newBaseUrl = newMasterUrl.substring(
          0,
          newMasterUrl.lastIndexOf("/") + 1,
        );
        const refreshedRes = await axios.get(newMasterUrl, {
          validateStatus: () => true,
        });

        if (
          refreshedRes.status < 200 ||
          refreshedRes.status >= 300 ||
          !refreshedRes.data
        ) {
          return h
            .response({ error: `Upstream Error ${refreshedRes.status}` })
            .code(refreshedRes.status);
        }

        record.baseUrl = newBaseUrl;
        record.subpath = (refreshedRes as AxiosResponse).data
          .split("\n")
          .find((line: string) => line.match(".m3u8"));

        if (!record.subpath) {
          return h.response({ error: "No valid subpath found" }).code(404);
        }

        const subUrl = new URL(record.subpath, record.baseUrl).href;
        res = await fetchPlaylist(subUrl, true);
        cache.set(cmd, record as CacheRecord);
      }

      const seqMatch = (res as AxiosResponse).data.match(sequenceRegex);
      let currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;

      const lines = (res as AxiosResponse).data.split("\n");
      const modifiedLines = lines.map((line: string) => {
        if (line.startsWith("#") || line.trim() === "") return line;
        if (line.match(".m3u8")) return line;

        const resourceId = `${cmd}<_>${currentSeq}`;
        record.segments.set(currentSeq, line);
        currentSeq++;

        return generateSignedUrl(resourceId, userLabel, meta);
      });

      cache.set(cmd, record as CacheRecord);

      return h
        .response(modifiedLines.join("\n"))
        .type("application/vnd.apple.mpegurl");
    } else {
      // Reuse the master URL resolved during populateCache — a second
      // create_link round-trip to the portal doubles startup latency.
      const masterUrl = record.masterUrl || await cmdPlayerV2(cmd);
      if (!masterUrl)
        return h.response({ error: "Stream Not Found" }).code(404);
      const res = await fetchPlaylist(masterUrl);
      if ((res as any).isBoom) return res;

      const seqMatch = (res as AxiosResponse).data.match(sequenceRegex);
      let currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;

      const lines = (res as AxiosResponse).data.split("\n");
      const modifiedLines = lines.map((line: string) => {
        if (line.startsWith("#") || line.trim() === "") return line;

        if (line.match(".m3u8")) {
          record.subpath = line;
          cache.set(cmd, record as CacheRecord);
          const token = mintOrReuseStreamToken(cmd, userLabel, undefined, meta);
          return `/live.m3u8?t=${token}&play=1&proxy=1`;
        }

        const resourceId = `${cmd}<_>${currentSeq}`;
        record.segments.set(currentSeq, line);
        currentSeq++;

        return generateSignedUrl(resourceId, userLabel, meta);
      });

      cache.set(cmd, record as CacheRecord);
      return h
        .response(modifiedLines.join("\n"))
        .type("application/vnd.apple.mpegurl");
    }
  } catch (error: any) {
    const message = error.message || String(error);
    logger.error(`Error: ${(error as Error)?.stack ?? error}`);

    if (axios.isAxiosError(error) && error.response) {
      return h
        .response({ error: "Upstream Error" })
        .code(error.response.status);
    }

    if (message.includes("Stream Not Found") || message.includes("404")) {
      return h.response({ error: "Stream Not Found" }).code(404);
    }

    return h.response({ error: "Failed to generate URL" }).code(500);
  }
}

async function handleNonProxy(cmd: string, h: ResponseToolkit<ReqRefDefaults>) {
  try {
    const redirectedUrl = await cmdPlayerV2(cmd);
    if (redirectedUrl) {
      return h.redirect(redirectedUrl).code(302);
    }
    return h.response({ error: "Unable to fetch stream [Non Proxy]" }).code(400);
  } catch (err) {
    logger.error(`Non-proxy error: ${err}`);
    return h.response({ error: "Stream fetch failed" }).code(500);
  }
}

export const liveRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/live.m3u8",
    handler: async (request, h) => {
      const { play, id, start_time, end_time, proxy: proxyParam } = request.query as {
        play?: string;
        id?: string;
        start_time?: string;
        end_time?: string;
        proxy?: string;
      };
      const entry = streamTokenFromRequest(request);
      if (!entry) return h.response({ error: "Unauthorized" }).code(401);
      const cmd = entry.resource;
      const userLabel = entry.userLabel;
      const meta: StreamMeta = { kind: entry.kind, label: entry.label, category: entry.category };
      streamTracker.touch("live", request.info.remoteAddress, cmd, userLabel, meta);
      if (id && initialConfig.providerType !== "xtream") {
        stalkerApi.setActiveChannel(id);
      }

      // proxy=1 forces proxying for browsers (they can't follow redirects to the
      // upstream portal — mixed content/CORS); proxy=0 forces a direct redirect.
      // Smart-TV webviews (Tizen/WebOS) are not CORS-bound and decode HLS natively,
      // so they get a direct redirect and stream from the portal without server load.
      const ua = String(request.headers["user-agent"] || "");
      const isSmartTv = /Tizen|SMART-TV|SmartTV|Web0S|WebOS/i.test(ua);
      const forceProxy = proxyParam === "1" && !isSmartTv;

      if (initialConfig.providerType === "xtream") {
        const useProxy = forceProxy || (initialConfig.proxy && proxyParam !== "0");
        if (useProxy) {
          const { liveStreamService } = await import("@/services/LiveStreamService");
          const { subpath } = request.query as { subpath?: string };
          const result = await liveStreamService.getPlaylist(cmd, play, subpath, userLabel);
          if (typeof result === "string") {
            return h.response(result).type("application/vnd.apple.mpegurl");
          } else {
            return h.response({ error: result.error }).code(result.code);
          }
        } else {
          try {
            const { serverManager } = await import("@/serverManager");
            const redirectedUrl = await serverManager
              .getProvider()
              .getChannelLink(cmd)
              .then((res) => res.js.cmd);
            if (redirectedUrl) {
              return h.redirect(redirectedUrl).code(302);
            }
            return h.response({ error: "Unable to fetch stream [Non Proxy]" }).code(400);
          } catch (err: any) {
            logger.error(`Non-proxy error: ${err.message || err}`);
            return h.response({ error: "Stream fetch failed" }).code(500);
          }
        }
      }

      if (start_time && end_time) {
        try {
          const redirectedUrl = await cmdPlayerV2(cmd, Number(start_time), Number(end_time));
          if (redirectedUrl) {
            return h.redirect(redirectedUrl).code(302);
          }
          return h.response({ error: "Unable to fetch catchup stream" }).code(400);
        } catch (err) {
          logger.error(`Catchup stream error: ${err}`);
          return h.response({ error: "Catchup stream fetch failed" }).code(500);
        }
      }

      const useProxy = forceProxy || (initialConfig.proxy && proxyParam !== "0");
      if (useProxy) return handleProxy(cmd, play, h, userLabel, meta);
      return handleNonProxy(cmd, h);
    },
  },
  {
    method: "GET",
    path: "/player/{resourceId}",
    handler: async (request, h) => {
      try {
        let { resourceId: token } = request.params as { resourceId: string };
        if (!token) {
          return h.response("Missing token").code(400);
        }
        if (token.endsWith(".ts")) {
          token = token.slice(0, -3);
        }

        const entry = resolveStreamToken(token);
        if (!entry) {
          return h.response("Invalid or expired token").code(403);
        }
        const resourceId = entry.resource; // "cmd<_>seq"
        const segmentUser = entry.userLabel;
        const segmentMeta: StreamMeta = { kind: entry.kind, label: entry.label, category: entry.category };

        if (initialConfig.providerType === "xtream") {
          // resourceId is `${cmd}<_>${seq}` (see LiveStreamService.populateCache) —
          // strip the sequence suffix so repeated segment fetches for the same
          // channel bucket into the same session as the cmd-keyed playlist touch.
          const streamKey = resourceId.split("<_>")[0];
          streamTracker.touch("live", request.info.remoteAddress, streamKey, segmentUser, segmentMeta);
          const { liveStreamService } = await import("@/services/LiveStreamService");
          try {
            const streamResponse = await liveStreamService.getSegmentByResourceId(resourceId, request.headers, segmentUser);
            const response = h
              .response(streamResponse.data)
              .code(streamResponse.status)
              .type(streamResponse.headers["content-type"] || "application/octet-stream")
              // Safe to cache aggressively: the token (and therefore this exact
              // URL) is stable per (resource, userLabel) via mintOrReuseStreamToken
              // and maps to one specific, immutable segment — it's never rewritten
              // to point at different bytes later.
              .header("Cache-Control", "public, max-age=30");

            ["content-length", "accept-ranges", "content-range"].forEach(
              (header) => {
                if (streamResponse.headers[header]) {
                  response.header(header, streamResponse.headers[header]);
                }
              },
            );
            return response;
          } catch (err: any) {
            // Log the real error (may include the upstream host in a DNS/connection
            // failure message) but never forward err.message to the client — that's
            // exactly the kind of string that leaks the real portal address.
            logger.error(`[Player] Xtream Segment fetch error: ${err.message || err}`);
            return h.response("Segment fetch failed").code(err.response?.status || 502);
          }
        }

        const parts = resourceId.split("<_>");
        if (parts.length !== 2) {
          return h.response("Invalid resource ID format").code(400);
        }
        const seqStr = parts.pop();
        const cmd = parts.join("<_>");
        const seqId = Number(seqStr);

        if (isNaN(seqId)) {
          return h.response("Invalid sequence ID").code(400);
        }

        streamTracker.touch("live", request.info.remoteAddress, cmd, segmentUser, segmentMeta);

        let record: CacheRecord | undefined = cache.get(cmd);

        if (!record || !record.segments.has(seqId)) {
          try {
            logger.info(
              `Segment ${seqId} missing in cache for ${cmd}. Refreshing...`,
            );
            await populateCache(cmd);
            record = cache.get(cmd);
          } catch (err) {
            logger.error(`Failed to refresh cache for ${cmd}: ${err}`);
          }
        }

        if (!record || !record.segments.has(seqId)) {
          const keys = record ? Array.from(record.segments.keys()) : [];
          const min = keys.length ? Math.min(...keys) : 0;
          const max = keys.length ? Math.max(...keys) : 0;

          logger.warn(
            `Sequence Out of Range: Requested ${seqId}, Available ${min} to ${max}`,
          );
          return h.response("Segment not found").code(404);
        }

        const segmentPath = record.segments.get(seqId);
        if (!segmentPath) return h.response("Segment path invalid").code(404);

        // Kick off read-ahead for the following segment
        prefetchNextSegment(cmd, seqId + 1, record);

        const segmentUrl = new URL(segmentPath, record.baseUrl).href;

        // Non-Range requests go through the shared segment cache — this both
        // reuses an already-prefetched segment AND, on a cold miss, primes the
        // cache from this exact fetch so the *next* viewer (of this or any
        // other session watching the same channel) is served from memory
        // instead of triggering their own independent origin fetch. Range
        // requests skip this (same as before) — this cache only ever holds a
        // full segment buffer, not arbitrary byte ranges.
        if (!request.headers.range) {
          const key = segmentKey(cmd, seqId);
          primeSegment(key, () => fetchSegmentBuffer(segmentUrl));
          const seg = await readSegment(key);
          if (seg) {
            return h
              .response(seg.data)
              .type(seg.contentType)
              .header("content-length", String(seg.data.length))
              // Same reasoning as the Xtream path above — this token/URL is
              // stable and maps to one immutable segment.
              .header("Cache-Control", "public, max-age=30");
          }
          // Buffered fetch failed — fall through to the raw streaming fallback below.
        }

        try {
          return await new Promise((resolve, reject) => {
            const parsedUrl = new URL(segmentUrl);
            const isHttps = parsedUrl.protocol === "https:";
            const client = isHttps ? https : http;

            const agent = isHttps ? httpsAgent : httpAgent;

            const headers: Record<string, string> = {};

            ["range", "accept", "accept-encoding"].forEach((header) => {
              if (request.headers[header]) {
                headers[header] = request.headers[header] as string;
              }
            });

            const options: RequestOptions = {
              method: "GET",
              hostname: parsedUrl.hostname,
              port: parsedUrl.port || (isHttps ? "443" : "80"),
              path: parsedUrl.pathname + parsedUrl.search,
              headers,
              agent,
            };

            const req = client.request(options, (res) => {
              if (![200, 206].includes(res.statusCode || 0)) {
                res.resume();
                return reject(
                  new Error(
                    `Failed to fetch segment: Upstream ${res.statusCode}`,
                  ),
                );
              }

              const response = h
                .response(res)
                .code(res.statusCode || 200)
                .type(
                  res.headers["content-type"] || "application/octet-stream",
                );

              ["content-length", "accept-ranges", "content-range"].forEach(
                (header) => {
                  if (res.headers[header]) {
                    response.header(header, res.headers[header] as string);
                  }
                },
              );

              // Only tag full (200) responses as long-cacheable — a 206 partial
              // response's bytes depend on the Range that was requested, so
              // caching it under this same URL for a future full-file request
              // would be wrong.
              if (res.statusCode === 200) {
                response.header("Cache-Control", "public, max-age=30");
              }

              resolve(response);
            });

            // Kill the upstream request if the client disconnects mid-transfer
            // (seek/channel-change/tab-close) — otherwise it runs to completion
            // wasting bandwidth and holding a socket open for nothing.
            const onClientClose = () => {
              if (!req.destroyed) req.destroy();
            };
            request.raw.req.on("close", onClientClose);

            req.setTimeout(25000, () => {
              req.destroy();
              reject(new Error("Stream request timeout"));
            });

            req.on("error", (err) => {
              logger.error(`[Player] HTTP stream error: ${err}`);
              reject(new Error("Stream connection failed"));
            });

            req.on("close", () => {
              request.raw.req.off("close", onClientClose);
            });

            req.end();
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[Player] Error fetching segment: ${message}`);
          return h
            .response(`[Player] Error fetching segment: ${message}`)
            .code(502);
        }
      } catch (err: any) {
        logger.error({ err }, "[Player] Detailed Error");
        logger.error(`[Player] Error fetching segment: ${err.message || err}`);

        return h
          .response({
            error: "Internal Server Error",
            details: err.message || "Unknown error occurred",
          })
          .code(500);
      }
    },
  },
];
