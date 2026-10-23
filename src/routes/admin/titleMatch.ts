import { ServerRoute } from "@hapi/hapi";
import { requireAdmin } from "@/auth/jwt";
import { ContentMeta } from "@/models/ContentMeta";
import { fixPortalMatch, LOCAL_CATEGORY } from "@/content/metaEnrichment";
import { logger } from "@/infra/logger";
import { recordFromRequest } from "@/services/SecurityEvents";

// Admin "Fix match" on a portal title's detail page (content/metaEnrichment.ts fixPortalMatch).
// The candidates come from /api/admin/libraries/match-search, shared with the local library.
// Under /api/admin/ (admin-gated in server.ts) and re-checked here. {id}: "movie_123", "series_L4".

const ID_RE = /^(movie|series)_[\w-]+$/;
const forbidden = (h: any) => h.response({ error: "Forbidden" }).code(403);

export const titleMatchRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/titles/{id}/match",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const id = String(request.params.id);
      if (!ID_RE.test(id)) return h.response({ error: "Bad id" }).code(400);
      const row = await ContentMeta.findByPk(id, { attributes: ["id", "type", "name", "year", "tmdbId", "imdbId", "tmdbIdLocked", "portalCategoryId"] });
      if (!row || row.portalCategoryId === LOCAL_CATEGORY) return h.response({ error: "Unknown title" }).code(404);
      return {
        id,
        kind: row.type === "series" ? "series" : "movie",
        name: row.name,
        year: row.year || null,
        tmdbId: row.tmdbId ? Number(row.tmdbId) : null,
        imdbId: row.imdbId || null,
        locked: row.tmdbIdLocked != null,
      };
    },
  },
  {
    // { tmdbId }: match to that TMDB title and keep it; { tmdbId: null }: match automatically again.
    method: "POST",
    path: "/api/admin/titles/{id}/match",
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return forbidden(h);
      const id = String(request.params.id);
      if (!ID_RE.test(id)) return h.response({ error: "Bad id" }).code(400);
      const raw = (request.payload as any)?.tmdbId;
      const tmdbId = raw === null || raw === undefined || raw === "" ? null : Number(raw);
      if (tmdbId !== null && (!Number.isInteger(tmdbId) || tmdbId <= 0)) return h.response({ error: "Bad TMDB id" }).code(400);
      let result;
      try {
        result = await fixPortalMatch(id, tmdbId);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        logger.error(`[MetaEnrich] fix match of ${id} failed: ${msg}`);
        if (/^TMDB has no /.test(msg)) return h.response({ error: msg }).code(400);
        const busy = /SQLITE_BUSY|database is locked/i.test(msg);
        return h.response({ error: busy ? "The database is busy (metadata is being filled in). Try again in a minute." : "Could not save the match" }).code(busy ? 503 : 500);
      }
      if (!result) return h.response({ error: "Unknown title" }).code(404);
      recordFromRequest(request, "setting_changed", `${id} matched to ${tmdbId ?? "auto"}`, (admin as any).userId ?? null);
      return { id, ...result };
    },
  },
];
