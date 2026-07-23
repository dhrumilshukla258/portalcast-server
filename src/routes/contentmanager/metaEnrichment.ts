import { ServerRoute } from "@hapi/hapi";
import { logger } from "@/infra/logger";
import { enrichContentMeta } from "@/content/metaEnrichment";
import { ContentMeta } from "@/models/ContentMeta";
import { requireAdmin, forbidden } from "./shared";

export const metaEnrichmentRoutes: ServerRoute[] = [
  {
    // Manual trigger only — same reasoning as /api/admin/strm/generate: a full-catalog
    // TMDB backfill takes hours at the throttled rate, so this must never run automatically
    // on cache warm. Safe to call repeatedly — enrichContentMeta() skips any ContentMeta
    // row that already has enrichedAt set, so re-triggering only picks up newly-discovered
    // content, not a full re-scan.
    method: "POST",
    path: "/api/admin/content-meta/enrich",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      enrichContentMeta({ includeBackdropBackfill: true }).catch((e) => logger.error({ err: e }, "[MetaEnrich] enrich error"));
      return h.response({ success: true, message: "Content metadata enrichment started in background" });
    },
  },
  {
    method: "GET",
    path: "/api/admin/content-meta/status",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const [total, byType, bySource] = await Promise.all([
        ContentMeta.count(),
        ContentMeta.count({ group: ["type"] }) as unknown as Promise<{ type: string; count: number }[]>,
        ContentMeta.count({ group: ["source"] }) as unknown as Promise<{ source: string; count: number }[]>,
      ]);
      return h.response({ total, byType, bySource });
    },
  },
];
