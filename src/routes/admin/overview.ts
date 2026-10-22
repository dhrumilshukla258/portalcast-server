import { ServerRoute } from "@hapi/hapi";
import { Op } from "sequelize";
import { requireAdmin } from "@/auth/jwt";
import { User } from "@/models/User";
import { StreamFailure } from "@/models/StreamFailure";
import { SecurityEvent } from "@/models/SecurityEvent";
import { LocalItem } from "@/models/LocalItem";
import { listJobs } from "@/services/jobs";
import { iptvHealth } from "@/services/portalHealth";
import { outboundStats } from "@/services/outboundTraffic";
import { streamTracker } from "@/services/StreamTracker";
import { requestMetrics } from "@/services/RequestMetrics";
import { socketService } from "@/services/SocketService";
import { logger } from "@/infra/logger";
import { lastIntegrity } from "@/services/integrity";
import { setting } from "@/config/settings";
import { catalogSnapshot } from "@/content/catalog/store";
import { shadowStatus } from "@/content/catalog/shadow";

// Admin > Overview: everything the front page shows, in one small answer. The counts that
// need the database are cached for 15 s (several open admin tabs polling cost one set of
// queries); streams, jobs, health and traffic are in memory and always current.

/** Security events worth a look (the Security tab marks the same kinds as severe). */
const SEVERE_KINDS = ["refresh_reuse", "image_proxy_blocked", "forbidden", "ip_banned", "suspicious_request"];
const COUNTS_TTL_MS = 15_000;

interface Counts {
  pendingUsers: number;
  activeToday: number;
  brokenStreams: number;
  securityAlerts: number;
  unmatchedLocal: number;
  missingLocal: number;
}
let counts: { at: number; value: Counts } | null = null;
let countsInflight: Promise<Counts> | null = null;

async function loadCounts(): Promise<Counts> {
  if (counts && Date.now() - counts.at < COUNTS_TTL_MS) return counts.value;
  if (countsInflight) return countsInflight;
  countsInflight = (async () => {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const [pendingUsers, activeToday, brokenStreams, securityAlerts, unmatchedLocal, missingLocal] = await Promise.all([
      User.count({ where: { isActive: false } }),
      User.count({ where: { lastLogin: { [Op.gte]: dayAgo } } }),
      StreamFailure.count({ where: { dismissed: false, autoHidden: false, failureCount: { [Op.gt]: 0 } } }),
      SecurityEvent.count({ where: { kind: SEVERE_KINDS, createdAt: { [Op.gte]: dayAgo } } }),
      LocalItem.count({ where: { missingSince: null, matchedTmdbId: null } }),
      LocalItem.count({ where: { missingSince: { [Op.ne]: null } } }),
    ]);
    const value = { pendingUsers, activeToday, brokenStreams, securityAlerts, unmatchedLocal, missingLocal };
    counts = { at: Date.now(), value };
    return value;
  })().finally(() => { countsInflight = null; });
  return countsInflight;
}

/** One row per person and title (a playback can open several stream sessions). */
function watching() {
  const seen = new Map<string, { user: string | null; title: string | null; kind: string | null; category: string | null; startedAt: number }>();
  for (const s of streamTracker.list()) {
    const key = `${s.user ?? s.ip}|${s.label ?? s.resource}`;
    const prev = seen.get(key);
    if (!prev || s.startedAt < prev.startedAt) {
      seen.set(key, { user: s.user, title: s.label, kind: s.kind ?? (s.type === "live" ? "live" : null), category: s.category, startedAt: s.startedAt });
    }
  }
  return [...seen.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export const overviewRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/overview",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      try {
        const c = await loadCounts();
        const jobs = listJobs();
        const failedJobs = jobs.filter((j) => j.lastError && !j.running).map((j) => ({ name: j.name, label: j.label, error: j.lastError }));
        const runningJobs = jobs.filter((j) => j.running).map((j) => j.label);
        const metrics = requestMetrics.snapshot();
        const health = iptvHealth();
        const mem = process.memoryUsage();
        const snap = setting<boolean>("catalogSnapshot") ? catalogSnapshot() : null;
        const shadow = shadowStatus();
        return {
          health: {
            iptv: health.iptv,
            iptvSince: health.since,
            uptimeSeconds: Math.round(process.uptime()),
            memoryMb: Math.round(mem.rss / 1048576),
            // The in-memory catalog (content/catalog/), when on: its version and the shadow
            // check of its answers against the database (plan, Phase 1b rollout).
            catalog: snap ? { version: snap.version, sizeMb: Math.round(snap.bytes / 1048576), checked: shadow.checked, differed: shadow.differed } : undefined,
          },
          // Only what needs the admin; the page shows nothing here when all is well.
          needs: {
            pendingUsers: c.pendingUsers,
            brokenStreams: c.brokenStreams,
            securityAlerts: c.securityAlerts,
            unmatchedLocal: c.unmatchedLocal,
            missingLocal: c.missingLocal,
            failedJobs,
            iptvOffline: health.iptv !== "online",
            // Repeats or orphans the nightly integrity job could not repair (normally 0).
            dataIssues: lastIntegrity()?.issues ?? 0,
            // Answers from the in-memory catalog that differed from the database (normally 0).
            catalogDifferences: snap ? shadow.differed : 0,
          },
          watching: watching(),
          runningJobs,
          today: {
            activeUsers: c.activeToday,
            connectedDevices: socketService.getActiveDeviceCount(),
            portalRequests: metrics.totalRequests,
            portalErrors: metrics.totalErrors,
            portalSince: metrics.since,
            outboundLastHour: outboundStats().lastHour?.total ?? null,
          },
        };
      } catch (error) {
        logger.error({ err: error }, "Error loading admin overview");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
];
