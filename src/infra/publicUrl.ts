import { Request } from "@hapi/hapi";
import { serverProtocol } from "@/config/server";
import { logger } from "@/infra/logger";
import { proxiedImageUrl } from "@/providers/portalAssets";

// Resolves the URL the client actually used so generated links work both when
// the server is reached directly (ip:port) and through a reverse proxy (domain).
//
// Priority:
//   1. PUBLIC_BASE_URL env var (e.g. "https://iptv.example.com") — hard override
//   2. X-Forwarded-Proto / X-Forwarded-Host headers set by the reverse proxy
//   3. The Host header of the incoming request

function parseBaseUrl(): { proto: "http" | "https"; host: string } | null {
  const raw = process.env.PUBLIC_BASE_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return { proto: u.protocol === "https:" ? "https" : "http", host: u.host };
  } catch {
    logger.warn(`[publicUrl] Invalid PUBLIC_BASE_URL "${raw}" — ignoring. Fix this env var or generated URLs will be wrong.`);
    return null;
  }
}

const baseUrlOverride = parseBaseUrl();

export function getPublicProto(request: Request): "http" | "https" {
  if (baseUrlOverride) return baseUrlOverride.proto;
  const fwd = request.headers["x-forwarded-proto"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim() === "https" ? "https" : "http";
  }
  return serverProtocol;
}

export function getPublicHost(request: Request): string {
  if (baseUrlOverride) return baseUrlOverride.host;
  const fwd = request.headers["x-forwarded-host"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim();
  }
  return request.info.host || "localhost:3000";
}

export function getPublicOrigin(request: Request): string {
  return `${getPublicProto(request)}://${getPublicHost(request)}`;
}

// Xtream player clients (TiviMate, IPTV Smarters, etc.) fetch image URLs directly
// and unauthenticated — they parse whatever fully-qualified URL sits in the JSON
// response, they don't prefix a relative path themselves the way the web UI does.
// xtreamCache.ts's buildIconUrl() stores the REAL upstream URL in the persisted
// cache (it's our own DB, never sent to a client) — the conversion to a
// same-origin proxied URL happens only here, per-request, right before
// responding. Same "store real, convert at serve time" pattern used everywhere
// else this server proxies images (mapChannel, enrichArtworkFromTmdb, Discover),
// so there's nothing to backfill if this logic ever changes: every row, old or
// new, gets converted fresh on every read.
const ICON_FIELDS = ["cover", "cover_big", "movie_image", "stream_icon"] as const;

export function absolutizeIconFields<T extends Record<string, any>>(obj: T, origin: string): T {
  const out: any = { ...obj };
  for (const field of ICON_FIELDS) {
    const value = out[field];
    if (typeof value !== "string" || !value) continue;
    const proxied = proxiedImageUrl(value);
    out[field] = proxied.startsWith("/") ? `${origin}${proxied}` : proxied;
  }
  return out;
}

export function absolutizeIconFieldsList<T extends Record<string, any>>(items: T[], origin: string): T[] {
  return items.map((item) => absolutizeIconFields(item, origin));
}
