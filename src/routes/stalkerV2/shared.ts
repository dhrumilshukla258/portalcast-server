import axios from "axios";
import { Readable } from "stream";
import crypto from "crypto";
import { initialConfig } from "@/config/server";
import { ConfigProfile } from "@/models/ConfigProfile";
import { authCheck } from "@/auth/jwt";
import { mintStreamToken } from "@/services/StreamTokens";
import { xtreamCache } from "@/services/xtreamCache";
import { fetchMovieMeta, fetchTVMeta } from "@/content/tmdb";
import { channelLogoPath } from "@/providers/portalAssets";

// Resolves a stable, human-readable identity label for the "active streams"
// admin view from the request's JWT — undefined for unauthenticated requests
// (stream URLs then carry no uid and show up by IP only).
export const streamUserLabel = (request: any): string | undefined => {
  const payload = authCheck(request);
  return payload ? (payload.email || `user:${payload.userId}`) : undefined;
};

export const CACHE_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

export const resolveStalkerUrl = (stalker: any, urlPath: string): string => {
  if (!urlPath) return "";

  let cleanedPath = urlPath.trim();
  const httpMatch = cleanedPath.match(/(https?:\/\/[^\s"']+)/);
  if (httpMatch) {
    cleanedPath = httpMatch[1];
  } else {
    const spaceIndex = cleanedPath.indexOf(" ");
    if (spaceIndex !== -1) {
      const parts = cleanedPath.split(/\s+/);
      const pathPart = parts.find(p => p.startsWith("/") || p.includes("."));
      if (pathPart) {
        cleanedPath = pathPart;
      }
    }
  }

  if (cleanedPath.startsWith("http://") || cleanedPath.startsWith("https://")) {
    return cleanedPath;
  }

  const baseHost = `http://${initialConfig.hostname}:${initialConfig.port}`;
  const context = initialConfig.contextPath ? `/${initialConfig.contextPath}` : "";
  const normalizedPath = cleanedPath.startsWith("/") ? cleanedPath : `/${cleanedPath}`;

  if (context && normalizedPath.startsWith(context)) {
    return `${baseHost}${normalizedPath}`;
  }
  return `${stalker.getBaseUrl()}${normalizedPath}`;
};

// Resolves an HLS playlist to its ordered list of absolute media-segment URLs,
// following one level of master->variant redirection if the playlist has no segments of its own.
export const resolveHlsSegmentUrls = async (
  playlistUrl: string,
  headers: Record<string, any>,
  params: Record<string, any>,
): Promise<string[]> => {
  const res = await axios({
    method: "get",
    url: playlistUrl,
    headers,
    params,
    responseType: "text",
    validateStatus: () => true,
  });
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`HLS playlist fetch failed (${res.status}): ${playlistUrl}`);
  }
  const text = typeof res.data === "string" ? res.data : String(res.data);
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  // Many CDNs gate every segment (not just the master playlist) behind the same
  // ?token=...&filter=... query string, which relative segment URIs don't carry on their
  // own — so it has to be forwarded onto each resolved segment/variant URL.
  const queryIndex = playlistUrl.indexOf("?");
  const baseNoQuery = queryIndex === -1 ? playlistUrl : playlistUrl.slice(0, queryIndex);
  const playlistQuery = queryIndex === -1 ? "" : playlistUrl.slice(queryIndex + 1);
  const baseUrl = baseNoQuery.substring(0, baseNoQuery.lastIndexOf("/") + 1);

  const resolveUri = (uri: string): string => {
    const absolute = uri.startsWith("http") ? uri : `${baseUrl}${uri}`;
    if (!playlistQuery || absolute.includes("?")) return absolute;
    return `${absolute}?${playlistQuery}`;
  };

  const variantLine = lines.find((l) => !l.startsWith("#") && l.includes(".m3u8"));
  if (variantLine) {
    return resolveHlsSegmentUrls(resolveUri(variantLine), headers, params);
  }

  const segmentLines = lines.filter((l) => !l.startsWith("#"));
  if (segmentLines.length === 0) {
    throw new Error("HLS playlist contained no segments");
  }
  return segmentLines.map(resolveUri);
};

// Lazily fetches and yields each segment in order, one at a time — the server never
// holds more than one segment in memory, and the client reassembles the file as it downloads.
export async function* streamHlsSegments(
  segmentUrls: string[],
  headers: Record<string, any>,
  params: Record<string, any>,
): AsyncGenerator<Buffer> {
  for (const segUrl of segmentUrls) {
    const segRes = await axios({
      method: "get",
      url: segUrl,
      headers,
      params,
      responseType: "stream",
      validateStatus: () => true,
    });
    if (segRes.status !== 200 && segRes.status !== 206) {
      throw new Error(`HLS segment fetch failed (${segRes.status}): ${segUrl}`);
    }
    for await (const chunk of segRes.data as Readable) {
      yield chunk;
    }
  }
}

// Enriches web UI items with TMDB data alongside whatever the portal already provides.
// Images (poster/backdrop) prefer TMDB first, then the portal's own image, then empty —
// TMDB artwork is simply higher quality/more consistent than most portals'. Text details
// (cast/director/overview) go the other way: prefer the portal's own data, and only fall
// back to TMDB when the portal doesn't have it. Results are cached per item (including
// "not found") so this is only a one-time cost per catalog item, not per page load.
//
// Cache misses are NOT awaited — the response returns immediately with whatever's already
// known, and the TMDB lookup runs in the background to populate the cache for next time.
// This keeps every page load fast regardless of TMDB's response time; the trade-off is a
// brand-new (never-viewed) item may show without its TMDB image until a later reload.
export async function enrichArtworkFromTmdb(items: any[], kind: "movie" | "series"): Promise<any[]> {
  return Promise.all(
    items.map(async (item: any) => {
      const itemId = item.id ?? item.stream_id ?? item.series_id;
      if (!itemId) return item;

      // mapSeriesItem also sets `backdrop_path` to an Xtream-protocol array ([] or
      // [url]) on the same cached object — an empty array is truthy in JS, so a plain
      // `||` would let it silently win over a real TMDB backdrop string. Only accept it
      // here if it's actually a non-empty string.
      const existingBackdrop = typeof item.backdrop_path === "string" && item.backdrop_path
        ? item.backdrop_path
        : undefined;

      const cacheKey = `tmdb_web_${kind}_${itemId}`;
      const meta = await xtreamCache.get<any>(cacheKey);

      if (meta === undefined || meta === null) {
        if (!(item.screenshot_uri && existingBackdrop && item.actors && item.director)) {
          const name = item.name || item.title || "";
          const year = String(item.year || item.releaseDate || item.added || "").slice(0, 4);
          const lookup = kind === "movie" ? fetchMovieMeta(name, year) : fetchTVMeta(name, year);
          lookup
            .then((fetched) => xtreamCache.set(cacheKey, fetched ?? { _not_found: true }))
            .catch(() => {});
        }
        return { ...item, backdrop_path: existingBackdrop };
      }

      if (meta && !meta._not_found) {
        return {
          ...item,
          screenshot_uri: meta.poster || item.screenshot_uri,
          backdrop_path: meta.backdrop || existingBackdrop,
          description: item.description || meta.overview || item.description,
          actors: item.actors || meta.cast || item.actors,
          director: item.director || meta.director || item.director,
          trailer_key: meta.trailerKey || undefined,
        };
      }
      return { ...item, backdrop_path: existingBackdrop };
    }),
  );
}

export const getActiveProfileId = async () => {
  const activeProfile = await ConfigProfile.findOne({
    where: { isActive: true },
  });
  return activeProfile?.id;
};

// Generates dynamic deterministic keys for parameters
export const generateCacheKey = (type: string, queryParams: any): string => {
  const sortedString = JSON.stringify(
    queryParams,
    Object.keys(queryParams).sort(),
  );
  return `${type}_${crypto.createHash("md5").update(sortedString).digest("hex")}`;
};

// origin is the public base URL of this server (reverse-proxy aware), so the
// returned cmd is a complete playable URL that can be copied into any player.
// For BOTH provider types, channel.cmd at this point is the real upstream
// stream URL (for xtream it even embeds the admin's real upstream Xtream
// credentials in plaintext) — never hand that to the client. Route it through
// our own /live.m3u8 behind an opaque token instead.
export const mapChannel = (channel: any, origin: string, userLabel?: string, genreTitle?: string) => {
  let cmdUrl: string;
  let logo = channel.logo || channel.screenshot_uri || "";
  if (userLabel) {
    const token = mintStreamToken(channel.cmd, userLabel, undefined, {
      kind: "live",
      label: channel.name,
      category: genreTitle,
    });
    cmdUrl = `${origin}/live.m3u8?t=${token}&id=${channel.id}&proxy=1`;
  } else {
    // No resolved identity — omit the token entirely; /live.m3u8 will 401.
    cmdUrl = `${origin}/live.m3u8?id=${channel.id}&proxy=1`;
  }
  if (initialConfig.providerType === "stalker") {
    // Frontend prefixes non-http values with /api/images — hand it a portal-root path
    logo = channelLogoPath(logo);
  }
  return {
    ...channel,
    cmd: cmdUrl,
    screenshot_uri: logo,
    isPortal: initialConfig.providerType === "stalker",
  };
};
