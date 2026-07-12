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
export const downloadRoutes: ServerRoute[] = [
  {
    // JWT-gated (not in the auth-exempt list) — mints the token `/api/v2/download`
    // requires. The frontend calls this first, then `window.open()`s the returned
    // URL, since the download itself is a plain navigation that can't carry a
    // Bearer header.
    method: "GET",
    path: "/api/v2/download-link",
    handler: async (request, h) => {
      const userLabel = streamUserLabel(request);
      if (!userLabel) return h.response({ error: "Unauthorized" }).code(401);

      const { id, series, isSeries, cmd, title } = request.query as {
        id?: string;
        series?: string;
        isSeries?: string;
        cmd?: string;
        title?: string;
      };
      if (!id) return h.response({ error: "Missing id" }).code(400);

      const downloadToken = mintDownloadToken(
        {
          id,
          series,
          isSeries: isSeries === "1" || isSeries === "true",
          cmd,
          title,
        },
        userLabel
      );
      return h.response({ url: `/api/v2/download?t=${downloadToken}` });
    },
  },
  {
    method: "GET",
    path: "/api/v2/download",
    handler: async (request, h) => {
      try {
        // Can't require a Bearer header here — this URL is opened via
        // `window.open`, a plain navigation. So the target (id/series/cmd/
        // path) is resolved from a server-minted token instead of trusting
        // client-supplied query params directly, see mintDownloadToken above.
        const entry = streamTokenFromRequest(request);
        if (!entry) return h.response({ error: "Unauthorized" }).code(401);
        let downloadPayload: DownloadPayload;
        try {
          downloadPayload = JSON.parse(entry.resource);
        } catch {
          return h.response({ error: "Invalid token" }).code(400);
        }
        const { id, series, cmd, path } = downloadPayload;
        const isSeries = downloadPayload.isSeries ? "1" : undefined;
        const title = downloadPayload.title;

        // Sanitize the title for use as a filename (strip path-unsafe characters), falling
        // back to `movie_<id>`/`episode_<id>` when no title was supplied.
        const buildFilename = (isSeriesFlag: boolean, ext: string) => {
          const safeTitle = title ? title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() : "";
          const base = safeTitle || `${isSeriesFlag ? "episode" : "movie"}_${id}`;
          return `${base}.${ext}`;
        };

        const provider = serverManager.getProvider();

        // If direct resolution parameters are provided
        if (id) {
          const isSeriesBoolTop = isSeries === "1" || isSeries === "true";

          if (initialConfig.providerType === "stalker") {
            const stalker = provider as any;
            let token = stalker.cache.get("auth_token");
            if (!token) {
              token = await stalker.getToken(false);
            }

            const isSeriesBool = isSeries === "1" || isSeries === "true";

            // The frontend's `cmd` may be an already-resolved external CDN URL cached from
            // whenever this item was last listed — its token/session is often long expired
            // by the time "download" is clicked. create_link needs an internal path/id, not
            // a stale external link, so only forward `cmd` here if it isn't one; otherwise
            // let the portal derive its own (fresh) cmd from `id`.
            const internalCmd = cmd && !/^https?:\/\//i.test(cmd) ? cmd : undefined;

            // Try download mode (download=1)
            let linkData: any;
            if (isSeriesBool) {
              linkData = await stalker.getSeriesLink({
                series: series || "0",
                id: Number(id),
                download: 1,
                cmd: internalCmd,
              });
            } else {
              linkData = await stalker.getMovieLink({
                series: series || "0",
                id: Number(id),
                download: 1,
                cmd: internalCmd,
              });
            }

            let resolvedUrl = linkData?.js?.cmd || linkData?.cmd;
            if (resolvedUrl) {
              resolvedUrl = resolveStalkerUrl(stalker, resolvedUrl);
            }

            // If we got a valid download link, let's request it
            if (resolvedUrl && !resolvedUrl.includes("error=nothing_to_play") && !(linkData?.js?.error === "nothing_to_play")) {
              const config = stalker._getAxiosRequestConfig({}, token || "");
              
              // Validate that get_download_link.php doesn't return 404
              const validateRes = await axios({
                method: "get",
                url: resolvedUrl,
                headers: config.headers,
                params: config.params,
                validateStatus: () => true,
              });

              // If it's valid, request stream proxy
              if (validateRes.status === 200 || validateRes.status === 206) {
                // If it returned nothing_to_play in data, skip to play fallback
                const dataStr = typeof validateRes.data === "string" ? validateRes.data : JSON.stringify(validateRes.data);
                if (!dataStr.includes("nothing_to_play")) {
                  if (resolvedUrl.includes(".m3u8")) {
                    // HLS-backed VOD: the playlist alone isn't a playable file, so stream every
                    // media segment through in order, one at a time, without buffering server-side.
                    const segmentUrls = await resolveHlsSegmentUrls(resolvedUrl, config.headers, config.params);
                    const filename = buildFilename(isSeriesBool, "ts");
                    return h.response(Readable.from(streamHlsSegments(segmentUrls, config.headers, config.params), { objectMode: false }))
                      .header("Content-Type", "video/mp2t")
                      .header("Content-Disposition", `attachment; filename="${filename}"`)
                      .code(200);
                  }

                  const response = await axios({
                    method: "get",
                    url: resolvedUrl,
                    headers: config.headers,
                    params: config.params,
                    responseType: "stream",
                    validateStatus: () => true,
                  });

                  const proxyResponse = h.response(response.data);
                  // Deliberately exclude content-disposition from the upstream
                  // copy — the portal's own filename is often just a
                  // quality/language descriptor (e.g. "Hindi / Excellent
                  // quality (1080)"), not the real title. Always set our own
                  // below, built from `title`.
                  const headersToCopy = ["content-type", "content-length", "accept-ranges", "content-range"];
                  for (const [key, value] of Object.entries(response.headers)) {
                    if (value && headersToCopy.includes(key.toLowerCase())) {
                      proxyResponse.header(key, value.toString());
                    }
                  }
                  const urlExt = resolvedUrl.split("?")[0].split(".").pop();
                  const ext = urlExt && urlExt.length <= 4 ? urlExt : "mp4";
                  proxyResponse.header("Content-Disposition", `attachment; filename="${buildFilename(isSeriesBool, ext)}"`);
                  proxyResponse.code(response.status);
                  return proxyResponse;
                }
              }
            }

            // Fallback: Try play mode (download=0)
            let playLinkData: any;
            if (isSeriesBool) {
              playLinkData = await stalker.getSeriesLink({
                series: series || "0",
                id: Number(id),
                download: 0,
                cmd: internalCmd,
              });
            } else {
              playLinkData = await stalker.getMovieLink({
                series: series || "0",
                id: Number(id),
                download: 0,
                cmd: internalCmd,
              });
            }

            let playUrl = playLinkData?.js?.cmd || playLinkData?.cmd;
            if (playUrl) {
              playUrl = resolveStalkerUrl(stalker, playUrl);
            }
            if (playUrl) {
              const config = stalker._getAxiosRequestConfig({}, token || "");

              // If playUrl is an m3u8 playlist, stream its segments through in order instead of
              // saving the bare playlist (which isn't a playable file on its own).
              if (playUrl.includes(".m3u8") || playUrl.includes("index.m3u8")) {
                const segmentUrls = await resolveHlsSegmentUrls(playUrl, config.headers, config.params);
                const filename = buildFilename(isSeriesBool, "ts");
                return h.response(Readable.from(streamHlsSegments(segmentUrls, config.headers, config.params), { objectMode: false }))
                  .header("Content-Type", "video/mp2t")
                  .header("Content-Disposition", `attachment; filename="${filename}"`)
                  .code(200);
              } else {
                // Otherwise stream the play link direct file
                const response = await axios({
                  method: "get",
                  url: playUrl,
                  headers: config.headers,
                  params: config.params,
                  responseType: "stream",
                  validateStatus: () => true,
                });

                const proxyResponse = h.response(response.data);
                const headersToCopy = ["content-type", "content-length", "accept-ranges", "content-range"];
                for (const [key, value] of Object.entries(response.headers)) {
                  if (value && headersToCopy.includes(key.toLowerCase())) {
                    proxyResponse.header(key, value.toString());
                  }
                }
                const urlExt = playUrl.split("?")[0].split(".").pop();
                const ext = urlExt && urlExt.length <= 4 ? urlExt : "mp4";
                proxyResponse.header("Content-Disposition", `attachment; filename="${buildFilename(isSeriesBool, ext)}"`);
                proxyResponse.code(response.status);
                return proxyResponse;
              }
            }
            return h.response({ error: "Failed to resolve stream link for download" }).code(404);
          } else {
            // For Xtream and others
            let playUrl = "";
            if (path && path.startsWith("/")) {
              playUrl = `http://${initialConfig.hostname}:${initialConfig.port}${path}`;
            } else if (path) {
              playUrl = path;
            } else if (cmd) {
              playUrl = cmd;
            }
            if (playUrl) {
              const directHeaders = { "User-Agent": "VLC/3.0.16 LibVLC/3.0.16" };

              if (playUrl.includes(".m3u8")) {
                const segmentUrls = await resolveHlsSegmentUrls(playUrl, directHeaders, {});
                const filename = buildFilename(isSeriesBoolTop, "ts");
                return h.response(Readable.from(streamHlsSegments(segmentUrls, directHeaders, {}), { objectMode: false }))
                  .header("Content-Type", "video/mp2t")
                  .header("Content-Disposition", `attachment; filename="${filename}"`)
                  .code(200);
              }

              const response = await axios({
                method: "get",
                url: playUrl,
                headers: directHeaders,
                responseType: "stream",
                validateStatus: () => true,
              });

              const proxyResponse = h.response(response.data);
              const headersToCopy = ["content-type", "content-length", "accept-ranges", "content-range"];
              for (const [key, value] of Object.entries(response.headers)) {
                if (value && headersToCopy.includes(key.toLowerCase())) {
                  proxyResponse.header(key, value.toString());
                }
              }
              const urlExt = playUrl.split("?")[0].split(".").pop();
              const ext = urlExt && urlExt.length <= 4 ? urlExt : "mp4";
              proxyResponse.header("Content-Disposition", `attachment; filename="${buildFilename(isSeriesBoolTop, ext)}"`);
              proxyResponse.code(response.status);
              return proxyResponse;
            }
            return h.response({ error: "Failed to resolve playUrl" }).code(404);
          }
        }

        // Old path parameter fallback
        if (!path) {
          return h.response({ error: "Missing path or id parameter" }).code(400);
        }

        let targetUrl = path;
        let headers: Record<string, string> = {};
        let params: Record<string, any> = {};

        if (initialConfig.providerType === "stalker") {
          const stalker = provider as any;
          let token = stalker.cache.get("auth_token");
          if (!token) {
            token = await stalker.getToken(false);
          }

          if (path) {
            targetUrl = resolveStalkerUrl(stalker, path);
          }

          const config = stalker._getAxiosRequestConfig({}, token || "");
          headers = config.headers;
          params = config.params || {};
        } else {
          if (path.startsWith("/")) {
            targetUrl = `http://${initialConfig.hostname}:${initialConfig.port}${path}`;
          } else {
            // Reject arbitrary external URLs to prevent SSRF
            const parsed = new URL(path);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
              return h.response({ error: "Invalid URL" }).code(400);
            }
            targetUrl = path;
          }
          headers = {
            "User-Agent": "VLC/3.0.16 LibVLC/3.0.16",
          };
        }

        const response = await axios({
          method: "get",
          url: targetUrl,
          headers: headers,
          params: params,
          responseType: "stream",
          validateStatus: () => true,
        });

        const proxyResponse = h.response(response.data);

        const headersToCopy = [
          "content-type",
          "content-length",
          "accept-ranges",
          "content-range",
        ];
        for (const [key, value] of Object.entries(response.headers)) {
          if (value && headersToCopy.includes(key.toLowerCase())) {
            proxyResponse.header(key, value.toString());
          }
        }
        const isSeriesFlag = isSeries === "1" || isSeries === "true";
        const urlExt = targetUrl.split("?")[0].split(".").pop();
        const ext = urlExt && urlExt.length <= 4 ? urlExt : "mp4";
        proxyResponse.header("Content-Disposition", `attachment; filename="${buildFilename(isSeriesFlag, ext)}"`);

        proxyResponse.code(response.status);
        return proxyResponse;
      } catch (error: any) {
        logger.error("Download proxy error: " + (error?.message ?? error));
        return h.response({ error: "Failed to proxy download", detail: error?.message ?? String(error) }).code(500);
      }
    },
  },


];
