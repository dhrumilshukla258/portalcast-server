import { SubtitleChoice } from "@/models/SubtitleChoice";
import type { SubtitleResult } from "@/content/opensubtitles";
import type { StreamTokenEntry } from "@/services/StreamTokens";
import { isValidSubdlPath } from "@/content/subdl";
import { isValidGestdownId } from "@/content/gestdown";

// Subtitles viewers kept on (owner 2026-11-04: "now we know this is the right subtitle file").
// A player reports the online subtitle that stayed on for a good part of a movie or an episode
// (POST /api/v2/subtitles/kept); the search then lists it first for everyone watching the same
// item, with how many viewers kept it on and the timing they used. Kept files are served from
// subtitle_files, so they load even while their provider's downloads fail.

export interface PlayingItem {
  profileId: number;
  itemType: "movie" | "episode";
  itemId: string;
}

export interface KeptSubtitle {
  key: string;
  /** Viewers who kept it on. */
  count: number;
  /** The timing most of them used (the median), in ms. */
  delayMs: number;
  label: string | null;
}

/** What a kept-subtitle result adds to a search result. */
export type RankedSubtitle = SubtitleResult & { kept?: number; keptDelayMs?: number };

/** A download id the server hands out (the same checks as /api/v2/subtitles/download). */
export function isSubtitleKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length > 260) return false;
  if (/^os:\d{1,12}$/.test(key)) return true;
  if (key.startsWith("subdl:")) return isValidSubdlPath(key.slice(6));
  if (key.startsWith("gd:")) return isValidGestdownId(key.slice(3));
  if (key.startsWith("jfsub:")) return /^[\w.:-]{1,200}$/.test(key.slice(6));
  return false;
}

/**
 * The movie or episode a stream token was minted for (live and unknown items: null). Each version
 * is its own item, since versions are timed differently (owner 2026-11-04: an HDCAM copy and an
 * HD copy can need different subtitles). Portal copies have their own ids; a library title's
 * files (1080p, 2160p) share the title's "L<id>", so a library file counts as "LF<file id>".
 */
export function playingItemOf(entry: StreamTokenEntry | null, activeProfileId: number): PlayingItem | null {
  if (!entry || (entry.itemType !== "movie" && entry.itemType !== "episode")) return null;
  const localFile = /^local:(\d{1,12})$/.exec(entry.resource ?? "");
  const itemId = localFile ? `LF${localFile[1]}` : String(entry.itemId ?? "").trim();
  if (!itemId || itemId.length > 64) return null;
  return { profileId: entry.profileId ?? activeProfileId, itemType: entry.itemType, itemId };
}

export function sourceOfKey(key: string): SubtitleResult["source"] {
  if (key.startsWith("subdl:")) return "subdl";
  if (key.startsWith("gd:")) return "gestdown";
  if (key.startsWith("jfsub:")) return "jellyfin";
  return "opensubtitles";
}

/** A release name as stored: one line, at most 200 characters. */
export function cleanLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const s = label.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return s || null;
}

/** Records (or moves) this viewer's choice for the item and language. */
export async function recordKept(item: PlayingItem, userId: number, lang: string, key: string, delayMs: number, label: string | null): Promise<void> {
  const where = { ...item, lang, userId };
  const row = await SubtitleChoice.findOne({ where });
  const delay = Math.max(-60_000, Math.min(60_000, Math.round(delayMs) || 0));
  if (row) {
    const sameFile = row.subtitleKey === key;
    await row.update({ subtitleKey: key, delayMs: delay, label: label ?? (sameFile ? row.label : null) });
  } else {
    await SubtitleChoice.create({ ...where, subtitleKey: key, delayMs: delay, label });
  }
}

/** The subtitles kept on for this item and language, the most viewers first. */
export async function keptFor(item: PlayingItem, lang: string): Promise<KeptSubtitle[]> {
  const rows = (await SubtitleChoice.findAll({ where: { ...item, lang }, raw: true })) as any[];
  return summarizeKept(rows);
}

export function summarizeKept(rows: { subtitleKey: string; delayMs: number; label: string | null; updatedAt?: Date | string }[]): KeptSubtitle[] {
  const by = new Map<string, { delays: number[]; label: string | null; at: number }>();
  for (const r of rows) {
    const at = r.updatedAt ? new Date(r.updatedAt).getTime() || 0 : 0;
    const g = by.get(r.subtitleKey) ?? { delays: [], label: null, at: 0 };
    g.delays.push(Number(r.delayMs) || 0);
    if (r.label && at >= g.at) g.label = r.label;
    g.at = Math.max(g.at, at);
    by.set(r.subtitleKey, g);
  }
  return [...by.entries()]
    .map(([key, g]) => ({ key, count: g.delays.length, delayMs: median(g.delays), label: g.label, at: g.at }))
    .sort((a, b) => b.count - a.count || b.at - a.at)
    .map(({ at: _at, ...k }) => k);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  const v = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.round(v / 50) * 50; // the players move timing in 50/250 ms steps
}

/**
 * [results] with the kept subtitles first (the most viewers first), each marked with its count
 * and timing. A kept file the search did not return is added from what was stored.
 */
export function withKept(results: SubtitleResult[], kept: KeptSubtitle[], lang: string): RankedSubtitle[] {
  if (kept.length === 0) return results;
  const keyOf = (r: SubtitleResult) => r.downloadId || `os:${r.fileId}`;
  const byKey = new Map(results.map((r) => [keyOf(r), r]));
  const first: RankedSubtitle[] = kept.map((k) => {
    const r = byKey.get(k.key);
    const base: SubtitleResult = r ?? {
      id: k.key,
      fileId: k.key.startsWith("os:") ? Number(k.key.slice(3)) : 0,
      downloadId: k.key,
      source: sourceOfKey(k.key),
      language: lang || "en",
      releaseName: k.label ?? "Subtitle",
      downloadCount: 0,
    };
    return { ...base, kept: k.count, keptDelayMs: k.delayMs };
  });
  const keptKeys = new Set(kept.map((k) => k.key));
  return [...first, ...results.filter((r) => !keptKeys.has(keyOf(r)))];
}
