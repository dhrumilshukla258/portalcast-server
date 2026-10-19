import axios from "axios";
import { Op } from "sequelize";
import { Readable } from "stream";
import { StreamFailure } from "@/models/StreamFailure";
import { ContentOverride } from "@/models/ContentOverride";
import { ContentCache } from "@/models/ContentCache";
import { ConfigProfile } from "@/models/ConfigProfile";
import { contentKey } from "@/content/overrides";
import { logger } from "@/infra/logger";
import type { StreamTokenMeta } from "@/services/StreamTokens";

// "Broken stream" tracking — titles the portal still LISTS but whose stream is
// dead (movie-link mints fine, then the upstream CDN fetch fails). The
// content-lifecycle sweep only handles titles the portal stops listing; this
// covers the rest. Owner's rule: after 3 failed tries hide the movie and show
// the admin a list of failed items so they can test/fix them.
// See docs/skill-stream-failures.md.

export const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AUTO_HIDE_THRESHOLD = 3;
const MAX_ATTEMPT_TOKENS = 10;
// Live tokens come from the channel list and are reused for every play of a
// channel, so one token ≠ one attempt — bucket live failures by time instead.
const LIVE_ATTEMPT_BUCKET_MS = 10 * 60 * 1000;
// How long an attempt stays "known healthy" in memory. For VOD this is the
// token TTL (a whole playback session): once bytes have flowed, a later
// transient segment error in the same attempt is not a strike. For live it's
// short, so a later failure/recovery cycle is still recorded.
const HEALTHY_TTL_VOD_MS = 6 * 60 * 60 * 1000;
const HEALTHY_TTL_LIVE_MS = 10 * 60 * 1000;

const healthy = new Map<string, number>(); // attemptKey -> expiresAt
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of healthy) if (exp < now) healthy.delete(k);
}, 10 * 60 * 1000).unref();

// Serialize DB work per item so concurrent player retries can't race the
// read-modify-write of failureCount/attemptTokens.
const locks = new Map<string, Promise<void>>();
function serialize(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn).catch((e) => {
    logger.error(`[StreamFailures] ${key}: ${e?.message ?? e}`);
  });
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
  return next;
}

function attemptKeyFor(meta: StreamTokenMeta, tokenId?: string): string {
  const base = meta.attemptId ?? tokenId ?? "unknown";
  if (meta.itemType === "live") return `${base}@${Math.floor(Date.now() / LIVE_ATTEMPT_BUCKET_MS)}`;
  return base;
}

export function hostOf(url?: string | null): string | null {
  if (!url) return null;
  const m = String(url).match(/https?:\/\/[^\s"']+/);
  if (!m) return null;
  try { return new URL(m[0]).host; } catch { return null; }
}

// Error strings can embed the upstream URL (DNS/connection errors) — strip
// anything URL-shaped before it reaches the DB or the admin UI.
export function sanitizeError(msg: unknown): string {
  return String(msg ?? "").replace(/https?:\/\/\S+/g, "<url>").slice(0, 300);
}

async function activeProfileId(): Promise<number> {
  const p = await ConfigProfile.findOne({ where: { isActive: true } });
  return p?.id ?? 0;
}

function overrideKeyFor(itemId: string): string {
  // Matches applyPortalItemOverrides, which keys by String(parseInt(id)).
  const n = parseInt(itemId);
  return contentKey("movie", isNaN(n) ? itemId : String(n));
}

// Movie list pages are cached (ContentCache, 4h) with overrides already
// applied — drop them so a hide/unhide shows up immediately.
async function invalidateMovieListCache(profileId: number): Promise<void> {
  await ContentCache.destroy({ where: { profileId, cacheKey: { [Op.like]: "movies_%" } } });
}

async function autoHide(row: StreamFailure): Promise<void> {
  const key = overrideKeyFor(row.itemId);
  const existing = await ContentOverride.findByPk(key);
  if (existing?.hidden) {
    // Already hidden by an admin — not ours, so never mark it auto-hidden
    // (unhide must not undo a manual decision).
    logger.info(`[StreamFailures] ${key} already hidden manually — not auto-hiding`);
    return;
  }
  if (existing) {
    await existing.update({ hidden: true });
  } else {
    await ContentOverride.create({
      item_key: key,
      item_type: "movie",
      display_name: null,
      hidden: true,
      target_category_id: null,
      original_category_id: null,
      sort_order: null,
    });
  }
  row.autoHidden = true;
  row.autoHiddenAt = new Date();
  await invalidateMovieListCache(row.profileId);
  logger.warn(`[StreamFailures] Auto-hid ${key} ("${row.title ?? "?"}") after ${row.failureCount} failed attempts`);
}

// Fire-and-forget: never throws, never delays the response being served.
export function recordFailure(
  meta: StreamTokenMeta,
  tokenId: string | undefined,
  status: number | null,
  error: string,
  upstreamUrl?: string | null,
): void {
  if (!meta?.itemType || !meta.itemId) return;
  const attempt = attemptKeyFor(meta, tokenId);
  const healthyUntil = healthy.get(attempt);
  if (meta.itemType !== "live" && healthyUntil && healthyUntil > Date.now()) return; // transient mid-play error
  healthy.delete(attempt);

  const itemType = meta.itemType;
  const itemId = String(meta.itemId);
  void serialize(`${meta.profileId ?? "?"}:${itemType}:${itemId}`, async () => {
    const profileId = meta.profileId ?? (await activeProfileId());
    const now = new Date();
    // find-then-create rather than findOrCreate (which wraps a transaction —
    // avoidable lock time on SQLite's single writer). The per-item serialize()
    // above already prevents the in-process race; the catch covers a restart race.
    let row = await StreamFailure.findOne({ where: { profileId, itemType, itemId } });
    if (!row) {
      try {
        row = await StreamFailure.create({ profileId, itemType, itemId, failureCount: 0, attemptTokens: [] });
      } catch {
        row = await StreamFailure.findOne({ where: { profileId, itemType, itemId } });
        if (!row) throw new Error("could not create stream_failures row");
      }
    }

    let attempts = Array.isArray(row.attemptTokens) ? [...row.attemptTokens] : [];
    let count = row.failureCount ?? 0;
    if (row.lastFailedAt && now.getTime() - new Date(row.lastFailedAt).getTime() > FAILURE_WINDOW_MS) {
      attempts = [];
      count = 0;
    }
    const isNewAttempt = !attempts.includes(attempt);
    if (isNewAttempt) {
      count += 1;
      attempts.push(attempt);
      if (attempts.length > MAX_ATTEMPT_TOKENS) attempts = attempts.slice(-MAX_ATTEMPT_TOKENS);
      if (row.dismissed) row.dismissed = false; // new failures re-open a dismissed row
    }

    row.failureCount = count;
    row.attemptTokens = attempts;
    row.lastStatus = status;
    row.lastError = sanitizeError(error);
    const host = hostOf(upstreamUrl);
    if (host) row.upstreamHost = host;
    if (meta.label) row.title = meta.label;
    if (meta.category) row.category = meta.category;
    if (meta.resolve) row.resolveParams = meta.resolve;
    if (meta.hideable === false) row.hideable = false;
    else if (meta.hideable === true) row.hideable = true;
    row.firstFailedAt = row.firstFailedAt ?? now;
    row.lastFailedAt = now;

    if (itemType === "movie" && row.hideable && !row.autoHidden && count >= AUTO_HIDE_THRESHOLD) {
      await autoHide(row);
    }
    row.changed("attemptTokens", true);
    await row.save();
    if (isNewAttempt) {
      logger.warn(`[StreamFailures] ${itemType} ${itemId} ("${row.title ?? "?"}") failed (${status ?? "network"}: ${row.lastError}) — attempt ${count}`);
    }
  });
}

// Cheap on the hot path: an in-memory check short-circuits every segment
// after the first success of an attempt, so the DB is touched at most once
// per attempt (once per 10 min for live).
export function recordSuccess(meta: StreamTokenMeta, tokenId?: string): void {
  if (!meta?.itemType || !meta.itemId) return;
  const attempt = attemptKeyFor(meta, tokenId);
  const now = Date.now();
  const until = healthy.get(attempt);
  if (until && until > now) return;
  healthy.set(attempt, now + (meta.itemType === "live" ? HEALTHY_TTL_LIVE_MS : HEALTHY_TTL_VOD_MS));

  const itemType = meta.itemType;
  const itemId = String(meta.itemId);
  void serialize(`${meta.profileId ?? "?"}:${itemType}:${itemId}`, async () => {
    const profileId = meta.profileId ?? (await activeProfileId());
    const row = await StreamFailure.findOne({ where: { profileId, itemType, itemId } });
    if (!row || row.autoHidden || (row.failureCount ?? 0) === 0) return;
    await row.update({ failureCount: 0, attemptTokens: [] });
  });
}

// ── Admin actions ────────────────────────────────────────────────────────────

export type FailureStatusFilter = "active" | "hidden" | "all";

export async function listFailures(status: FailureStatusFilter) {
  const where: any = {};
  if (status === "active") Object.assign(where, { dismissed: false, autoHidden: false, failureCount: { [Op.gt]: 0 } });
  else if (status === "hidden") Object.assign(where, { autoHidden: true });
  const rows = await StreamFailure.findAll({ where, order: [["lastFailedAt", "DESC"]], limit: 500 });
  return rows.map(serializeFailure);
}

export function serializeFailure(r: StreamFailure) {
  return {
    id: r.id,
    profileId: r.profileId,
    itemType: r.itemType,
    itemId: r.itemId,
    title: r.title,
    category: r.category,
    failureCount: r.failureCount,
    threshold: r.itemType === "movie" && r.hideable ? AUTO_HIDE_THRESHOLD : null,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    upstreamHost: r.upstreamHost,
    hideable: r.hideable,
    autoHidden: r.autoHidden,
    autoHiddenAt: r.autoHiddenAt,
    dismissed: r.dismissed,
    firstFailedAt: r.firstFailedAt,
    lastFailedAt: r.lastFailedAt,
  };
}

export async function unhideFailure(row: StreamFailure): Promise<void> {
  const key = overrideKeyFor(row.itemId);
  const ov = await ContentOverride.findByPk(key);
  if (ov) {
    const hasOtherOverrides = ov.display_name != null || ov.target_category_id != null || ov.sort_order != null;
    if (hasOtherOverrides) await ov.update({ hidden: false });
    else await ov.destroy();
  }
  await row.update({ autoHidden: false, autoHiddenAt: null, failureCount: 0, attemptTokens: [] });
  await invalidateMovieListCache(row.profileId);
}

export async function dismissFailure(row: StreamFailure): Promise<void> {
  await row.update({ dismissed: true, failureCount: 0, attemptTokens: [] });
}

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_HEADERS = { "User-Agent": "VLC/3.0.16 LibVLC/3.0.16", Accept: "*/*" };

// GETs the first bytes of a URL; for an HLS playlist, follows the first
// variant/segment (up to 2 levels) so "playlist OK but segments dead" fails.
async function probeUrl(url: string, depth = 0): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const res = await axios.get(url, {
    responseType: "stream",
    headers: { ...PROBE_HEADERS, Range: "bytes=0-4095" },
    timeout: PROBE_TIMEOUT_MS,
    validateStatus: () => true,
  });
  const stream = res.data as Readable;
  let head = "";
  try {
    if (res.status < 200 || res.status >= 400) {
      return { ok: false, status: res.status, error: `Upstream returned HTTP ${res.status}` };
    }
    for await (const chunk of stream) {
      head += Buffer.from(chunk).toString("utf8");
      if (head.length >= 4096) break;
    }
  } finally {
    stream.destroy();
  }
  if (head.trimStart().startsWith("#EXTM3U") && depth < 2) {
    const finalUrl = (res.request as any)?.res?.responseUrl || url;
    const next = head.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (!next) return { ok: false, status: res.status, error: "Playlist has no entries" };
    return probeUrl(new URL(next, finalUrl).href, depth + 1);
  }
  return { ok: true, status: res.status };
}

function extractHttpUrl(raw: unknown): string | null {
  const m = String(raw ?? "").match(/https?:\/\/[^\s"']+/);
  return m ? m[0] : null;
}

export async function testFailure(row: StreamFailure): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const profileId = await activeProfileId();
  if (profileId !== row.profileId) {
    return { ok: false, status: null, error: "This item belongs to a profile that is not active — switch profiles to test it." };
  }
  const { serverManager } = await import("@/serverManager");
  const provider = serverManager.getProvider();
  const params = row.resolveParams ?? {};
  let upstream: string | null = null;
  let result: { ok: boolean; status: number | null; error?: string };
  try {
    if (row.itemType === "live") {
      if (!params.cmd) return { ok: false, status: null, error: "No channel cmd recorded for this item — play it once to capture it." };
      const link: any = await provider.getChannelLink(params.cmd);
      upstream = extractHttpUrl(link?.js?.cmd ?? link?.cmd);
    } else {
      const id = Number(params.id ?? row.itemId);
      const series = params.series ?? "";
      const isSeries = !!series && series !== "0" && series !== "false";
      const link: any = isSeries
        ? await provider.getSeriesLink({ series, id, download: 0, cmd: params.cmd as any })
        : await provider.getMovieLink({ series, id, download: 0, cmd: params.cmd as any });
      upstream = extractHttpUrl(link?.js?.cmd ?? link?.cmd);
    }
    if (!upstream) {
      result = { ok: false, status: null, error: "Portal did not return a stream URL" };
    } else {
      result = await probeUrl(upstream);
    }
  } catch (e: any) {
    result = { ok: false, status: e?.response?.status ?? null, error: sanitizeError(e?.message ?? e) };
  }

  if (result.ok) {
    if (!row.autoHidden) await row.update({ failureCount: 0, attemptTokens: [] });
  } else {
    const host = hostOf(upstream);
    await row.update({
      lastStatus: result.status,
      lastError: sanitizeError(result.error),
      ...(host ? { upstreamHost: host } : {}),
    });
  }
  return result;
}

// runDbCleanup: drop rows nobody has touched in 30 days, except auto-hidden
// ones (they're the record of why a title is hidden).
export async function purgeStaleFailures(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return StreamFailure.destroy({ where: { autoHidden: false, updatedAt: { [Op.lt]: cutoff } } });
}
