import { ServerRoute } from "@hapi/hapi";
import { Op } from "sequelize";
import { requireAdmin } from "@/auth/jwt";
import { ContentMeta } from "@/models/ContentMeta";
import { mergeTitles, unmergeTitle, MergeRefused, naturalGroupKeyFor, LOCAL_CATEGORY } from "@/content/metaEnrichment";
import { listTitleMerges } from "@/content/titleMerges";
import { logger } from "@/infra/logger";
import { recordFromRequest } from "@/services/SecurityEvents";

// Admin "Merge with…" on a title's page (content/titleMerges.ts, metaEnrichment mergeTitles):
// titles that are one film or show but did not group as versions. Under /api/admin/
// (admin-gated in server.ts) and re-checked here. {id}: "movie_123", "series_L4".

const ID_RE = /^(movie|series)_[\w-]+$/;
const KEY_RE = /^(movie|series):.{1,400}$/;
const forbidden = (h: any) => h.response({ error: "Forbidden" }).code(403);
const ATTRS = ["id", "type", "name", "trimmedName", "year", "tmdbId", "groupKey", "portalCategoryId"];

const failure = (h: any, what: string, e: any) => {
  if (e instanceof MergeRefused) return h.response({ error: e.message }).code(400);
  const msg = String(e?.message ?? e);
  logger.error(`[MetaEnrich] ${what} failed: ${msg}`);
  const busy = /SQLITE_BUSY|database is locked/i.test(msg);
  return h.response({ error: busy ? "The database is busy (metadata is being filled in). Try again in a minute." : `Could not ${what}` }).code(busy ? 503 : 500);
};

export const titleMergeRoutes: ServerRoute[] = [
  {
    // What this title was merged into, and the titles merged into it.
    method: "GET",
    path: "/api/admin/titles/{id}/merges",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const id = String(request.params.id);
      if (!ID_RE.test(id)) return h.response({ error: "Bad id" }).code(400);
      const row = (await ContentMeta.findByPk(id, { attributes: ATTRS, raw: true })) as any;
      if (!row) return h.response({ error: "Unknown title" }).code(404);
      const natural = naturalGroupKeyFor(row.type, row.name, row.year, row.tmdbId, row.portalCategoryId);
      const all = listTitleMerges();
      return {
        id,
        type: row.type,
        name: row.trimmedName || row.name,
        mergedInto: all.find((m) => m.from === natural) ?? null,
        mergedHere: all.filter((m) => m.to === row.groupKey && m.from !== natural),
      };
    },
  },
  {
    // Titles to merge with: same type, by name (one card per title).
    method: "GET",
    path: "/api/admin/titles/merge-search",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return forbidden(h);
      const { type, q } = request.query as { type?: string; q?: string };
      if (type !== "movie" && type !== "series") return h.response({ error: "Bad type" }).code(400);
      const text = String(q ?? "").trim().slice(0, 100);
      if (text.length < 2) return { results: [] };
      const rows = (await ContentMeta.findAll({
        where: { type, isRepresentative: true, name: { [Op.like]: `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%` } },
        attributes: [...ATTRS, "poster"],
        limit: 30,
        raw: true,
      })) as any[];
      return {
        results: rows.map((r) => ({
          id: r.id,
          name: r.trimmedName || r.name,
          year: r.year ?? null,
          poster: r.poster ?? null,
          local: r.portalCategoryId === LOCAL_CATEGORY,
          group: r.groupKey,
        })),
      };
    },
  },
  {
    // { into: "movie_456" }: every copy of {id}'s title joins that title.
    method: "POST",
    path: "/api/admin/titles/{id}/merge",
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return forbidden(h);
      const id = String(request.params.id);
      const into = String((request.payload as any)?.into ?? "");
      if (!ID_RE.test(id) || !ID_RE.test(into)) return h.response({ error: "Bad id" }).code(400);
      try {
        const r = await mergeTitles(id, into);
        recordFromRequest(request, "setting_changed", `${id} merged into ${into}`, (admin as any).userId ?? null);
        return { success: true, ...r };
      } catch (e: any) {
        return failure(h, "merge the titles", e);
      }
    },
  },
  {
    // ?from=<group key>: undo that merge.
    method: "DELETE",
    path: "/api/admin/title-merges",
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return forbidden(h);
      const from = String((request.query as any)?.from ?? "");
      if (!KEY_RE.test(from)) return h.response({ error: "Bad key" }).code(400);
      try {
        const r = await unmergeTitle(from);
        if (!r) return h.response({ error: "No such merge" }).code(404);
        recordFromRequest(request, "setting_changed", `merge of ${from} undone`, (admin as any).userId ?? null);
        return { success: true, ...r };
      } catch (e: any) {
        return failure(h, "undo the merge", e);
      }
    },
  },
];
