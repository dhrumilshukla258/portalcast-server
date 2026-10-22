// How long the IPTV portal takes to give a play link (create_link), per kind: the plan's
// "provider link measurements" before deciding on link prefetch (Phase 5: start fetching the
// link before Play is pressed). The last 500 per kind, in memory; an hourly log line
//   [links] last hour: live n=14 p50 310 ms p90 820 ms max 1.4 s; movie n=3 ...
// and the same numbers for the admin overview (linkTimingSummary).

import { logger } from "@/infra/logger";

export type LinkKind = "live" | "movie" | "other";
const MAX = 500;
const samples = new Map<LinkKind, { at: number; ms: number; ok: boolean }[]>();

export function recordLinkTime(kind: LinkKind, ms: number, ok: boolean): void {
  let list = samples.get(kind);
  if (!list) samples.set(kind, (list = []));
  list.push({ at: Date.now(), ms: Math.round(ms), ok });
  if (list.length > MAX) list.splice(0, list.length - MAX);
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

/** Per kind over the last `sinceMs`: count, failures and p50 / p90 / p99 / max in ms. */
export function linkTimingSummary(sinceMs = 24 * 3600_000) {
  const from = Date.now() - sinceMs;
  const out: Record<string, { n: number; failed: number; p50: number; p90: number; p99: number; max: number }> = {};
  for (const [kind, list] of samples) {
    const recent = list.filter((s) => s.at >= from);
    const ok = recent.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
    if (!recent.length) continue;
    out[kind] = {
      n: recent.length,
      failed: recent.length - ok.length,
      p50: ok.length ? pct(ok, 50) : 0,
      p90: ok.length ? pct(ok, 90) : 0,
      p99: ok.length ? pct(ok, 99) : 0,
      max: ok.length ? ok[ok.length - 1] : 0,
    };
  }
  return out;
}

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const timer = setInterval(() => {
  const s = linkTimingSummary(3600_000);
  const parts = Object.entries(s).map(([k, v]) => `${k} n=${v.n}${v.failed ? ` (${v.failed} failed)` : ""} p50 ${fmt(v.p50)} p90 ${fmt(v.p90)} max ${fmt(v.max)}`);
  if (parts.length) logger.info(`[links] last hour: ${parts.join("; ")}`);
}, 3600_000);
timer.unref?.();
