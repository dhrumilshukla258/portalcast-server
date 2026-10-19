// Measured video quality per title (resolution, frame rate, codec), reported by the
// clients' players and attached to catalog responses as `video`.
//
// Why: portal titles carry quality words that are often wrong ("HDCam" on a clean 1080p
// file). The decoded stream is the truth, and every client already knows it once a title
// plays, so the first play fixes the badge for everyone.
//
// All rows are held in memory (one small object per played title) so decorating a page is
// an O(page) map lookup; writes go to SQLite and update the map.

import { MediaInfo } from "@/models/MediaInfo";
import { logger } from "@/infra/logger";

export type MediaItemType = "movie" | "episode";

export interface VideoInfo {
  width: number;
  height: number;
  fps: number | null;
  codec: string | null;
  /** "2160p" / "1080p" / "720p" / "480p" / "SD", from the decoded height. */
  label: string;
}

let byKey: Map<string, VideoInfo> | null = null;
let loading: Promise<Map<string, VideoInfo>> | null = null;

const keyOf = (profileId: number, type: MediaItemType, id: string) => `${profileId}:${type}:${normalizeId(id)}`;

/** "movie_123" / "123" / " 123 " -> "123"; non-numeric ids are kept as-is. */
export function normalizeId(id: string | number): string {
  const s = String(id).trim().replace(/^(movie|series|episode)_/, "");
  return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s;
}

/** Resolution class from the decoded size. Uses the larger of height and width/(16/9) so
 *  letterboxed 1920x800 still reads as 1080p. */
export function qualityLabel(width: number, height: number): string {
  const h = Math.max(height, Math.round((width * 9) / 16));
  if (h >= 2000) return "2160p";
  if (h >= 1300) return "1440p";
  if (h >= 1000) return "1080p";
  if (h >= 700) return "720p";
  if (h >= 560) return "576p";
  if (h >= 460) return "480p";
  return "SD";
}

function toInfo(r: { width: number; height: number; fps: number | null; codec: string | null }): VideoInfo {
  return { width: r.width, height: r.height, fps: r.fps, codec: r.codec, label: qualityLabel(r.width, r.height) };
}

async function load(): Promise<Map<string, VideoInfo>> {
  if (byKey) return byKey;
  if (loading) return loading;
  loading = (async () => {
    const rows = await MediaInfo.findAll({ raw: true });
    const m = new Map<string, VideoInfo>();
    for (const r of rows as any[]) m.set(keyOf(r.profileId, r.itemType, r.itemId), toInfo(r));
    byKey = m;
    return m;
  })().finally(() => { loading = null; });
  return loading;
}

export interface MediaInfoReport {
  itemType: MediaItemType;
  itemId: string;
  width: number;
  height: number;
  fps?: number | null;
  codec?: string | null;
}

/** Validates a client report; returns an error message or null. */
export function validateReport(r: any): string | null {
  if (!r || (r.itemType !== "movie" && r.itemType !== "episode")) return "itemType must be movie or episode";
  if (r.itemId == null || String(r.itemId).trim() === "" || String(r.itemId).length > 64) return "itemId required";
  const w = Number(r.width), h = Number(r.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 16 || h < 16 || w > 8192 || h > 8192) return "width/height out of range";
  if (r.fps != null && (!Number.isFinite(Number(r.fps)) || Number(r.fps) < 1 || Number(r.fps) > 240)) return "fps out of range";
  if (r.codec != null && (typeof r.codec !== "string" || r.codec.length > 40)) return "codec invalid";
  return null;
}

/** Store a measurement (latest wins). No-op when nothing changed. */
export async function recordMediaInfo(profileId: number, r: MediaInfoReport): Promise<VideoInfo> {
  const m = await load();
  const itemId = normalizeId(r.itemId);
  const fps = r.fps != null ? Math.round(Number(r.fps) * 1000) / 1000 : null;
  const codec = r.codec ? String(r.codec).slice(0, 40) : null;
  const info = toInfo({ width: r.width, height: r.height, fps, codec });
  const key = keyOf(profileId, r.itemType, itemId);
  const prev = m.get(key);
  if (prev && prev.width === info.width && prev.height === info.height && prev.fps === info.fps && prev.codec === info.codec) return prev;
  await MediaInfo.upsert({ profileId, itemType: r.itemType, itemId, width: r.width, height: r.height, fps, codec });
  m.set(key, info);
  logger.info(`[mediaInfo] ${r.itemType} ${itemId}: ${info.width}x${info.height}${fps ? ` @${fps}` : ""} (${info.label})`);
  return info;
}

/** Synchronous lookup once loaded (call ensureMediaInfoLoaded() first on a request path). */
export function getVideoInfo(profileId: number, type: MediaItemType, id: string | number): VideoInfo | undefined {
  return byKey?.get(keyOf(profileId, type, String(id)));
}

export async function ensureMediaInfoLoaded(): Promise<void> {
  await load();
}

/**
 * Adds `video` to each item that has a measurement. `idOf` picks the catalog id of an item.
 * Returns new objects only for items that change; the input array is not mutated.
 */
export async function withVideoInfo<T extends Record<string, any>>(
  items: T[],
  profileId: number | undefined,
  type: MediaItemType,
  idOf: (item: T) => string | number | undefined,
): Promise<T[]> {
  if (items.length === 0) return items;
  await load();
  const pid = profileId ?? 0;
  return items.map((it) => {
    const id = idOf(it);
    if (id == null) return it;
    const v = getVideoInfo(pid, type, id);
    return v ? { ...it, video: v } : it;
  });
}
