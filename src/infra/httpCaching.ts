// Fewer requests from the apps (speed plan): HTTP caching on stable reads, and the IPTV
// status on every answer.
//
// - `X-IPTV: online|offline` on every /api answer (services/portalHealth.ts): the apps learn
//   the portal's state from requests they make anyway, and only poll /api/v2/health/iptv
//   after a quiet stretch.
// - Stable GET answers carry `Cache-Control: private, max-age=N, must-revalidate` and a weak
//   `ETag`: within N seconds an app does not ask at all; after that it asks with
//   If-None-Match and an unchanged answer is a 304 with no body. `Vary: Authorization` keeps
//   each user's answers apart. `must-revalidate` also lets OkHttp (TV) store answers to
//   requests that carry a Bearer token. Play links, progress, admin and anything that sets
//   its own Cache-Control are left alone.
// - With the in-memory catalog on, every /api answer carries `X-Catalog-Version` (and Home
//   `X-Home-Version`), infra/answerVersion.ts. A catalog GET whose `v` equals the current
//   version is `private, max-age=1 year, immutable`: the apps keep it until the version moves.

import crypto from "crypto";
import type { Server } from "@hapi/hapi";
import { iptvHealth } from "@/services/portalHealth";
import { catalogAnswerVersion, homeAnswerVersion } from "@/infra/answerVersion";

const YEAR = 365 * 24 * 60 * 60;
const HOME_PATH = "/api/v2/home";

/** Path pattern -> seconds an app may reuse the answer without asking. */
const RULES: [RegExp, number][] = [
  [/^\/api\/v2\/discover\/facets$/, 300],
  [/^\/api\/v2\/discover\/(details|variants)$/, 600],
  [/^\/api\/v2\/people\/\d+$/, 600],
  [/^\/api\/v2\/search\/people$/, 300],
  [/^\/api\/v2\/discover\/(browse|rows|recommendations)$/, 60],
  [/^\/api\/v2\/(movie-groups|series-groups|groups)$/, 600],
  [/^\/api\/v2\/(movies|series)$/, 60],
];

function maxAgeFor(path: string): number | null {
  for (const [re, s] of RULES) if (re.test(path)) return s;
  return null;
}

const etagMatches = (header: string | undefined, etag: string) =>
  !!header && header.split(",").some((t) => t.trim() === etag || t.trim() === "*");

export function registerHttpCaching(server: Server): void {
  server.ext("onPreResponse", async (request, h) => {
    const r: any = request.response;
    if (!request.path.startsWith("/api/")) return h.continue;
    const iptv = iptvHealth().iptv;
    const version = await catalogAnswerVersion().catch(() => null);
    const homeVersion = version && request.path === HOME_PATH ? homeAnswerVersion(version) : null;
    if (r?.isBoom) {
      r.output.headers["X-IPTV"] = iptv;
      if (version) r.output.headers["X-Catalog-Version"] = version;
      return h.continue;
    }
    r?.header?.("X-IPTV", iptv);
    if (version) r?.header?.("X-Catalog-Version", version);
    if (homeVersion) r?.header?.("X-Home-Version", homeVersion);

    // Asked for at the current version: the answer cannot change at this address.
    const asked = (request.query as Record<string, unknown>)?.v;
    const current = request.path === HOME_PATH ? homeVersion : version;
    const pinned = request.method === "get" && r?.statusCode === 200 && !!current && asked === current;
    if (pinned && request.path === HOME_PATH) {
      r.header("Cache-Control", `private, max-age=${YEAR}, immutable`);
      r.header("Vary", "Authorization");
      return h.continue;
    }

    const maxAge = request.method === "get" && r?.statusCode === 200 ? maxAgeFor(request.path) : null;
    if (maxAge == null || r.headers?.["cache-control"] || r.headers?.["Cache-Control"]) return h.continue;
    const source = r.source;
    if (source == null || typeof source !== "object" || Buffer.isBuffer(source) || typeof source.pipe === "function") return h.continue;

    let body: string;
    try {
      body = JSON.stringify(source);
    } catch {
      return h.continue;
    }
    const etag = `W/"${crypto.createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;
    const cacheControl = pinned ? `private, max-age=${YEAR}, immutable` : `private, max-age=${maxAge}, must-revalidate`;
    if (etagMatches((request.headers as Record<string, string | undefined>)["if-none-match"], etag)) {
      return h.response().code(304).header("ETag", etag).header("Cache-Control", cacheControl).header("Vary", "Authorization").header("X-IPTV", iptv).takeover();
    }
    r.header("ETag", etag);
    r.header("Cache-Control", cacheControl);
    r.header("Vary", "Authorization");
    return h.continue;
  });
}
