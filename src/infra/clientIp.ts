// The real client address, for rate limits, bans and the security log.
//
// Behind a reverse proxy every request arrives from the proxy's address, so one bucket
// was shared by every viewer: a single runaway client could lock everyone out of live
// TV, and a login brute force was throttled per *proxy*. X-Forwarded-For is only trusted
// when the server is told which proxies to trust (TRUSTED_PROXIES), because anyone can
// send that header otherwise and pick their own identity.
//
//   TRUSTED_PROXIES=            (default) never trust the header
//   TRUSTED_PROXIES=private     trust it when the connection comes from a loopback or
//                               RFC1918 address (Docker, a proxy on the same host/LAN)
//   TRUSTED_PROXIES=10.0.0.5,172.18.0.0/16   explicit addresses or CIDRs

import type { Request } from "@hapi/hapi";
import net from "net";

const spec = (process.env.TRUSTED_PROXIES || "").trim();

type Matcher = (ip: string) => boolean;

function ipToInt(ip: string): number | null {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function normalizeIp(ip: string): string {
  const s = ip.trim();
  return s.startsWith("::ffff:") ? s.slice(7) : s;
}

export function isPrivateIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (ip === "::1" || ip === "127.0.0.1") return true;
  if (ip.includes(":")) return /^(fc|fd|fe80)/i.test(ip);
  const n = ipToInt(ip);
  if (n === null) return false;
  return (
    (n >>> 24) === 10 ||
    (n >>> 24) === 127 ||
    (n >>> 20) === (0xac10 >>> 4) || // 172.16.0.0/12
    (n >>> 16) === 0xc0a8 || // 192.168.0.0/16
    (n >>> 16) === 0xa9fe // 169.254.0.0/16
  );
}

function cidrMatcher(entry: string): Matcher | null {
  const [base, bitsStr] = entry.split("/");
  if (!net.isIP(base)) return null;
  if (bitsStr === undefined) return (ip) => normalizeIp(ip) === base;
  const bits = Number(bitsStr);
  if (net.isIPv4(base) && bits >= 0 && bits <= 32) {
    const b = ipToInt(base)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ip) => { const n = ipToInt(normalizeIp(ip)); return n !== null && ((n & mask) >>> 0) === ((b & mask) >>> 0); };
  }
  return null; // IPv6 CIDRs: list the exact address instead
}

const matchers: Matcher[] = spec === ""
  ? []
  : spec.toLowerCase() === "private"
    ? [isPrivateIp]
    : spec.split(",").map((e) => cidrMatcher(e.trim())).filter((m): m is Matcher => m !== null);

export const trustedProxiesConfigured = matchers.length > 0;

export function isTrustedProxy(ip: string): boolean {
  return matchers.some((m) => m(ip));
}

/**
 * Client address: the last X-Forwarded-For hop that is not a trusted proxy, when the
 * connection itself comes from a trusted proxy; otherwise the socket address.
 */
export function clientIp(request: Request): string {
  const remote = normalizeIp(request.info.remoteAddress || "");
  if (!trustedProxiesConfigured || !isTrustedProxy(remote)) return remote;
  const header = request.headers["x-forwarded-for"] as string | string[] | undefined;
  const chain = (Array.isArray(header) ? header.join(",") : header || "")
    .split(",")
    .map((s) => normalizeIp(s))
    .filter((s) => net.isIP(s));
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(chain[i])) return chain[i];
  }
  return remote;
}

/** True when the request reached us over HTTPS (directly or via a trusted proxy). */
export function isSecureRequest(request: Request): boolean {
  if (request.server.info.protocol === "https") return true;
  const remote = normalizeIp(request.info.remoteAddress || "");
  if (!trustedProxiesConfigured || !isTrustedProxy(remote)) return false;
  const proto = request.headers["x-forwarded-proto"];
  return String(Array.isArray(proto) ? proto[0] : proto || "").split(",")[0].trim().toLowerCase() === "https";
}
