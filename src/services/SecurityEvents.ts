// Security event log + automatic temporary bans.
//
// Every suspicious thing a client does is recorded here (see SecurityKind), batched to
// SQLite, and counted per address in memory. An address that keeps failing gets a
// temporary ban: every /api request from it answers 429 until the ban lapses. Admins
// see the log and the bans under Admin > Security and can lift a ban.
//
// Addresses come from infra/clientIp.ts. Behind a reverse proxy WITHOUT TRUSTED_PROXIES
// every request shares the proxy's address, so auto-bans are disabled in that case (they
// would lock everyone out); events are still recorded.

import { Op } from "sequelize";
import type { Request } from "@hapi/hapi";
import { SecurityEvent } from "@/models/SecurityEvent";
import { clientIp, isTrustedProxy, trustedProxiesConfigured, normalizeIp } from "@/infra/clientIp";
import { logger } from "@/infra/logger";

export type SecurityKind =
  | "login_failed"           // wrong password / unknown account
  | "login_disabled"         // sign-in to a disabled account
  | "login_throttled"        // auth endpoint rate limit hit
  | "google_token_invalid"
  | "token_invalid"          // bad or expired bearer token on an API route
  | "token_user_disabled"    // valid token, but the account is disabled/deleted
  | "forbidden"              // non-admin tried an admin route / mutation
  | "refresh_invalid"        // unknown, expired or revoked refresh token
  | "refresh_reuse"          // a rotated-away refresh token was replayed (stolen token)
  | "pairing_code_invalid"   // wrong TV pairing code
  | "stream_token_invalid"   // bad/expired stream token on a media route
  | "stream_throttled"       // media rate limit hit
  | "image_proxy_blocked"    // image proxy pointed at a private/loopback address
  | "upload_rejected"        // avatar upload was not an image
  | "reset_token_invalid"
  | "ip_banned"
  | "ip_unbanned";

export interface SecurityEventInput {
  kind: SecurityKind;
  ip: string;
  userId?: number | null;
  path?: string | null;
  detail?: string | null;
  userAgent?: string | null;
}

// ---- tuning -----------------------------------------------------------------------
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const BAN_AFTER_FAILURES = Number(process.env.SECURITY_BAN_AFTER || 20);
const BAN_MS = Number(process.env.SECURITY_BAN_MINUTES || 60) * 60 * 1000;
const RETENTION_DAYS = 30;
const FLUSH_MS = 2000;
const MEMORY_RECENT = 500;

/** Failures that count toward a ban (noise like throttling itself does not). */
const BANNABLE: ReadonlySet<SecurityKind> = new Set([
  "login_failed", "login_disabled", "google_token_invalid", "token_invalid", "forbidden",
  "refresh_invalid", "refresh_reuse", "pairing_code_invalid", "stream_token_invalid",
  "image_proxy_blocked", "reset_token_invalid",
]);

// ---- state ------------------------------------------------------------------------
const pending: SecurityEventInput[] = [];
const recent: (SecurityEventInput & { at: number })[] = [];
const failures = new Map<string, number[]>();          // ip -> failure timestamps (window)
const bans = new Map<string, { until: number; reason: string }>();
let flushTimer: NodeJS.Timeout | null = null;

function flush(): void {
  flushTimer = null;
  if (pending.length === 0) return;
  const rows = pending.splice(0, pending.length).map((e) => ({
    kind: e.kind, ip: e.ip, userId: e.userId ?? null, path: e.path ?? null,
    detail: e.detail ? String(e.detail).slice(0, 300) : null,
    userAgent: e.userAgent ? String(e.userAgent).slice(0, 200) : null,
    createdAt: new Date((e as any).at ?? Date.now()),
  }));
  SecurityEvent.bulkCreate(rows).catch((err) => logger.error(`[security] could not store ${rows.length} events: ${err?.message ?? err}`));
}

function scheduleFlush(): void {
  if (!flushTimer) { flushTimer = setTimeout(flush, FLUSH_MS); flushTimer.unref?.(); }
}

/** Auto-bans only when the address is meaningful (see file comment). */
function canBan(ip: string): boolean {
  if (!ip || ip === "unknown") return false;
  if (trustedProxiesConfigured) return !isTrustedProxy(ip);
  // No proxy configured: a private remote address is most likely the proxy itself.
  return !isPrivateOrLoopback(ip);
}

function isPrivateOrLoopback(ip: string): boolean {
  const n = normalizeIp(ip);
  return n === "127.0.0.1" || n === "::1" || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd]|fe80)/i.test(n);
}

export function record(event: SecurityEventInput): void {
  const at = Date.now();
  const e = { ...event, ip: normalizeIp(event.ip || "unknown"), at };
  pending.push(e);
  recent.push(e);
  if (recent.length > MEMORY_RECENT) recent.splice(0, recent.length - MEMORY_RECENT);
  scheduleFlush();

  if (BANNABLE.has(e.kind) && canBan(e.ip)) {
    const list = (failures.get(e.ip) ?? []).filter((t) => at - t < FAIL_WINDOW_MS);
    list.push(at);
    failures.set(e.ip, list);
    if (list.length >= BAN_AFTER_FAILURES && !isBanned(e.ip)) {
      ban(e.ip, `${list.length} failures in ${FAIL_WINDOW_MS / 60000} min (last: ${e.kind})`);
      failures.delete(e.ip);
    }
  }
  if (e.kind === "refresh_reuse") logger.warn(`[security] refresh token replay from ${e.ip} (user ${e.userId ?? "?"})`);
}

/** Convenience for route handlers. */
export function recordFromRequest(request: Request, kind: SecurityKind, detail?: string | null, userId?: number | null): void {
  record({
    kind, ip: clientIp(request), userId: userId ?? null, path: request.path, detail: detail ?? null,
    userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
  });
}

export function ban(ip: string, reason: string, ms: number = BAN_MS): void {
  const until = Date.now() + ms;
  bans.set(normalizeIp(ip), { until, reason });
  logger.warn(`[security] banned ${ip} for ${Math.round(ms / 60000)} min: ${reason}`);
  record({ kind: "ip_banned", ip, detail: reason });
}

export function unban(ip: string): boolean {
  const had = bans.delete(normalizeIp(ip));
  failures.delete(normalizeIp(ip));
  if (had) record({ kind: "ip_unbanned", ip });
  return had;
}

export function isBanned(ip: string): boolean {
  const b = bans.get(normalizeIp(ip));
  if (!b) return false;
  if (b.until <= Date.now()) { bans.delete(normalizeIp(ip)); return false; }
  return true;
}

export function listBans(): { ip: string; until: string; reason: string }[] {
  const now = Date.now();
  return [...bans].filter(([, b]) => b.until > now).map(([ip, b]) => ({ ip, until: new Date(b.until).toISOString(), reason: b.reason }));
}

export async function listEvents(opts: { kind?: string; ip?: string; limit?: number; sinceMs?: number }) {
  const where: any = {};
  if (opts.kind) where.kind = opts.kind;
  if (opts.ip) where.ip = normalizeIp(opts.ip);
  if (opts.sinceMs) where.createdAt = { [Op.gte]: new Date(Date.now() - opts.sinceMs) };
  const rows = await SecurityEvent.findAll({ where, order: [["createdAt", "DESC"]], limit: Math.min(opts.limit ?? 200, 1000), raw: true });
  return rows;
}

export async function summary(hours = 24) {
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const rows = (await SecurityEvent.findAll({ where: { createdAt: { [Op.gte]: since } }, attributes: ["kind", "ip"], raw: true })) as unknown as { kind: string; ip: string }[];
  const byKind: Record<string, number> = {};
  const byIp: Record<string, number> = {};
  for (const r of rows) { byKind[r.kind] = (byKind[r.kind] ?? 0) + 1; byIp[r.ip] = (byIp[r.ip] ?? 0) + 1; }
  const topIps = Object.entries(byIp).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([ip, count]) => ({ ip, count }));
  return { hours, total: rows.length, byKind, topIps, bans: listBans(), autoBan: { enabled: true, afterFailures: BAN_AFTER_FAILURES, windowMinutes: FAIL_WINDOW_MS / 60000, banMinutes: BAN_MS / 60000, trustedProxiesConfigured } };
}

export async function purgeOld(): Promise<number> {
  return SecurityEvent.destroy({ where: { createdAt: { [Op.lt]: new Date(Date.now() - RETENTION_DAYS * 86400 * 1000) } } });
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of failures) { const kept = list.filter((t) => now - t < FAIL_WINDOW_MS); if (kept.length) failures.set(ip, kept); else failures.delete(ip); }
  for (const [ip, b] of bans) if (b.until <= now) bans.delete(ip);
}, 60_000).unref();
