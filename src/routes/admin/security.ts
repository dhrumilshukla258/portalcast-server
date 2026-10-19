import { ServerRoute } from "@hapi/hapi";
import { requireAdmin } from "@/auth/jwt";
import { listEvents, summary, listBans, unban, ban } from "@/services/SecurityEvents";
import { activeSessions, revokeAllForUser } from "@/services/RefreshTokens";
import { isTrustedProxy, normalizeIp } from "@/infra/clientIp";
import net from "net";

// Admin > Security: what clients have been doing wrong, who is banned, active sessions.
// All routes sit under /api/admin/ (admin-gated in server.ts) and re-check requireAdmin.
export const securityRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/security/summary",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const hours = Math.min(24 * 30, Math.max(1, Number((request.query as any).hours) || 24));
      return summary(hours);
    },
  },
  {
    method: "GET",
    path: "/api/admin/security/events",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const q = request.query as any;
      const hours = Math.min(24 * 30, Math.max(1, Number(q.hours) || 24 * 7));
      return { items: await listEvents({ kind: q.kind || undefined, ip: q.ip || undefined, limit: Number(q.limit) || 200, sinceMs: hours * 3600 * 1000 }) };
    },
  },
  {
    method: "GET",
    path: "/api/admin/security/bans",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      return { items: listBans() };
    },
  },
  {
    method: "POST",
    path: "/api/admin/security/bans",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const body = request.payload as any;
      const ip = normalizeIp(String(body?.ip ?? ""));
      if (!net.isIP(ip)) return h.response({ error: "Invalid IP address" }).code(400);
      if (isTrustedProxy(ip)) return h.response({ error: "That address is a trusted proxy" }).code(400);
      const minutes = Math.min(24 * 60 * 30, Math.max(1, Number(body?.minutes) || 60));
      ban(ip, `manual (admin)`, minutes * 60 * 1000);
      return { success: true, items: listBans() };
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/security/bans/{ip}",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const ip = normalizeIp(decodeURIComponent(String(request.params.ip)));
      return { success: unban(ip), items: listBans() };
    },
  },
  {
    method: "GET",
    path: "/api/admin/security/sessions/{userId}",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const userId = Number(request.params.userId);
      if (!Number.isInteger(userId)) return h.response({ error: "Invalid user id" }).code(400);
      return { items: await activeSessions(userId) };
    },
  },
  {
    // Signs the user out everywhere (every device must sign in again).
    method: "POST",
    path: "/api/admin/security/sessions/{userId}/revoke",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const userId = Number(request.params.userId);
      if (!Number.isInteger(userId)) return h.response({ error: "Invalid user id" }).code(400);
      return { success: true, revoked: await revokeAllForUser(userId, "revoked by admin") };
    },
  },
];
