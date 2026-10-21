// Every request this server makes to the outside, counted by destination (speed plan:
// "the server asks the IPTV portal as little as possible"). Logged once an hour, e.g.
//   [outbound] last hour: 214 requests: portal itv/create_link 6, portal image 31, tmdb api 120, stream 57
// and kept for the admin page. It also records when the portal last answered, so the health
// check (services/portalHealth.ts) can rely on real traffic instead of probing every minute.

import type { AxiosInstance, AxiosStatic } from "axios";
import { initialConfig } from "@/config/server";
import { logger } from "@/infra/logger";

const counts = new Map<string, number>();
let lastHour: { at: string; total: number; byKind: Record<string, number> } | null = null;
let portalLastAnswer = 0;
let portalLastFailure = 0;

const portalHost = () => String((initialConfig as any).hostname || "").replace(/^https?:\/\//i, "").split(/[/:]/)[0].toLowerCase();

/** What kind of request `url` is: "portal <type>/<action>", "portal image", "tmdb api", ... */
export function classifyOutbound(url: string, params?: Record<string, any>, label?: string): string {
  if (label) return label;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "other";
  }
  const host = u.hostname.toLowerCase();
  if (host && host === portalHost()) {
    if (/\.php$/i.test(u.pathname)) {
      const type = params?.type ?? u.searchParams.get("type");
      const action = params?.action ?? u.searchParams.get("action");
      return `portal ${type ?? "?"}/${action ?? "?"}`;
    }
    if (/\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(u.pathname)) return "portal image";
    return "portal other";
  }
  if (host === "image.tmdb.org") return "tmdb image";
  if (host.endsWith("themoviedb.org")) return "tmdb api";
  if (host.endsWith("imdbws.com")) return "imdb";
  if (host.endsWith("omdbapi.com")) return "omdb";
  if (host.endsWith("tvmaze.com")) return "tvmaze";
  return "stream or other";
}

export function countOutbound(url: string, params?: Record<string, any>, label?: string): void {
  const kind = classifyOutbound(url, params, label);
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

/** A response (any status) or a network failure from `url`: tracks whether the portal answers. */
export function noteOutboundResult(url: string, answered: boolean): void {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return; }
  if (!host || host !== portalHost()) return;
  if (answered) portalLastAnswer = Date.now();
  else portalLastFailure = Date.now();
}

export function portalContact(): { lastAnswer: number; lastFailure: number } {
  return { lastAnswer: portalLastAnswer, lastFailure: portalLastFailure };
}

const fullUrl = (cfg: any) => {
  const base = cfg?.baseURL ? String(cfg.baseURL) : "";
  const url = String(cfg?.url ?? "");
  return /^https?:\/\//i.test(url) ? url : base.replace(/\/$/, "") + "/" + url.replace(/^\//, "");
};

/** Counts every request an axios instance makes, and notes the portal's answers. */
export function countAxios(instance: AxiosInstance | AxiosStatic): void {
  instance.interceptors.request.use((cfg: any) => {
    countOutbound(fullUrl(cfg), cfg?.params, cfg?.countAs);
    return cfg;
  });
  instance.interceptors.response.use(
    (res: any) => {
      noteOutboundResult(fullUrl(res?.config), true);
      return res;
    },
    (err: any) => {
      // An HTTP error status is still an answer; only a network failure means no contact.
      if (err?.config) noteOutboundResult(fullUrl(err.config), Boolean(err.response));
      return Promise.reject(err);
    },
  );
}

/** The last full hour's counts (admin page) and the current hour so far. */
export function outboundStats() {
  return { lastHour, thisHour: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])) };
}

const timer = setInterval(() => {
  const byKind = Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  lastHour = { at: new Date().toISOString(), total, byKind };
  counts.clear();
  if (total > 0) {
    logger.info(`[outbound] last hour: ${total} requests: ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
}, 60 * 60 * 1000);
timer.unref?.();
