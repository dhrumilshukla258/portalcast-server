import { ServerRoute } from "@hapi/hapi";
import { requireAdmin } from "@/auth/jwt";
import { logger } from "@/infra/logger";
import { StreamFailure } from "@/models/StreamFailure";
import {
  listFailures,
  serializeFailure,
  testFailure,
  unhideFailure,
  dismissFailure,
  type FailureStatusFilter,
} from "@/services/StreamFailures";

// Admin "Broken streams" view — see docs/skill-stream-failures.md.
// /api/admin/* is already admin-gated by server.ts's onPreHandler; each
// handler re-checks requireAdmin like the other admin routes do.

async function loadRow(request: any): Promise<StreamFailure | null> {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return StreamFailure.findByPk(id);
}

export const streamFailureRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/stream-failures",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const raw = String((request.query as any).status || "active");
      const status: FailureStatusFilter = raw === "hidden" || raw === "all" ? raw : "active";
      return { status, items: await listFailures(status) };
    },
  },
  {
    method: "POST",
    path: "/api/admin/stream-failures/{id}/test",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const row = await loadRow(request);
      if (!row) return h.response({ error: "Not found" }).code(404);
      try {
        const result = await testFailure(row);
        await row.reload();
        return { ...result, item: serializeFailure(row) };
      } catch (err: any) {
        logger.error(`[stream-failures] test ${row.id} failed: ${err?.message ?? err}`);
        return h.response({ error: "Test failed" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/admin/stream-failures/{id}/unhide",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const row = await loadRow(request);
      if (!row) return h.response({ error: "Not found" }).code(404);
      if (!row.autoHidden) {
        return h.response({ error: "This item was not hidden automatically — use the Content tab to change manual overrides." }).code(409);
      }
      await unhideFailure(row);
      return { success: true, item: serializeFailure(row) };
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/stream-failures/{id}",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const row = await loadRow(request);
      if (!row) return h.response({ error: "Not found" }).code(404);
      await dismissFailure(row);
      return { success: true, item: serializeFailure(row) };
    },
  },
];
