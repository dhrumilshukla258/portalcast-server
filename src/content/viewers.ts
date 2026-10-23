// The viewer store (plan, Phase 2): every viewer's watch progress in memory, so Continue
// Watching, "already watched" checks and Home rows never query user_progress. A viewer is a
// user on an IPTV profile (userId + profileId), the key progress has always used.
//
// This module is the only writer of user_progress (test/ownership.test.ts). Writes go to
// SQLite first; the row is then read back and put in memory, so memory holds exactly what the
// table holds, timestamps included. Writes to one row run one after another. Bulk changes
// (a pruned title, merged duplicates, sealing old stream links) reload the store: the table is
// small (78 rows for 5 viewers on the live data, ~37 KB).
//
// Rows are kept as Sequelize gives them (toJSON(): completed a boolean, dates as Date, meta as
// the column returns it), so the routes answer exactly as before.

import { UserProgress } from "@/models/UserProgress";
import { logger } from "@/infra/logger";
import { sealCmd, isUpstreamLink } from "@/infra/sealedCmd";

export interface ProgressRow {
  userId: number;
  profileId: number;
  mediaId: string;
  progress: number;
  completed: boolean;
  meta: any;
  createdAt: Date;
  updatedAt: Date;
}

type Viewer = Map<string, ProgressRow>;
let viewers = new Map<string, Viewer>();
let loaded: Promise<void> | null = null;
/** Bumped on every change: Home rows and other derived data compare it (Phase 2 nearline). */
let generation = 0;
/**
 * Finer than [generation], for Home (content/home.ts, infra/answerVersion.ts): one viewer's own
 * changes, and changes to what anyone has watched (the "Popular on this server" row). A
 * position saved every 30 s while someone watches moves only that viewer's (owner, 2026-10-23:
 * one viewer's playback emptied every viewer's cached Home).
 */
let loadGeneration = 0;
const ownGeneration = new Map<string, number>();
let watchedGeneration = 0;
const MONTH_MS = 30 * 86_400_000; // the window "Popular on this server" counts
const listeners: ((userId: number, profileId: number) => void)[] = [];

/** No active IPTV profile: as before (a query on profileId undefined failed), an error. */
const viewerKey = (userId: number | undefined, profileId: number | undefined) => {
  if (userId === undefined || profileId === undefined) throw new Error(userId === undefined ? "no user" : "no active profile");
  return `${userId}:${profileId}`;
};

/** Byte order (SQLite's BINARY collation): the order the primary key index returns mediaIds. */
const binaryCmp = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

const clone = (r: ProgressRow): ProgressRow => ({
  ...r,
  meta: r.meta && typeof r.meta === "object" ? structuredClone(r.meta) : r.meta,
  createdAt: new Date(r.createdAt),
  updatedAt: new Date(r.updatedAt),
});

async function loadAll(): Promise<void> {
  const rows = await UserProgress.findAll();
  const next = new Map<string, Viewer>();
  for (const r of rows) {
    const plain = r.toJSON() as ProgressRow;
    const key = viewerKey(plain.userId, plain.profileId);
    let v = next.get(key);
    if (!v) next.set(key, (v = new Map()));
    v.set(String(plain.mediaId), plain);
  }
  viewers = next;
  generation++;
  loadGeneration++;
}

/** Loads the store once (later calls wait for the same load). */
export function viewersReady(): Promise<void> {
  if (!loaded) loaded = loadAll().catch((e) => { loaded = null; throw e; });
  return loaded;
}

/** Reloads everything from the table (after a bulk change). */
async function reload(changedViewers?: { userId: number; profileId: number }[]): Promise<void> {
  await viewersReady();
  await loadAll();
  for (const v of changedViewers ?? []) for (const fn of listeners) fn(v.userId, v.profileId);
}

export function viewerGeneration(): number {
  return generation;
}

/** Changes when this viewer's history changes, or when what anyone has watched changes. */
export function viewerGenerationOf(userId: number, profileId: number): string {
  return `${loadGeneration}.${ownGeneration.get(`${userId}:${profileId}`) ?? 0}.${watchedGeneration}`;
}

/** A save changed what this row counts for in others' Home: watched or not, or a watched title
 *  coming back into the last 30 days. */
function watchedChanged(before: ProgressRow | undefined, after: ProgressRow | undefined): boolean {
  const was = !!before && isWatched(before), is = !!after && isWatched(after);
  if (was !== is) return true;
  return is && !!before && new Date(before.updatedAt).getTime() < Date.now() - MONTH_MS;
}

/** Called after a viewer's progress changed (Phase 2: their Home rows are rebuilt). */
export function onViewerChange(fn: (userId: number, profileId: number) => void): void {
  listeners.push(fn);
}

/** A viewer's rows in primary key order (as findAll({ where: { userId, profileId } }) returned
 *  them), as copies the caller may change. */
export async function progressRows(userId: number | undefined, profileId: number | undefined): Promise<ProgressRow[]> {
  await viewersReady();
  const v = viewers.get(viewerKey(userId, profileId));
  if (!v) return [];
  return [...v.values()].sort((a, b) => binaryCmp(a.mediaId, b.mediaId)).map(clone);
}

/** Every viewer's rows (copies), for server-wide figures such as what is popular here. Call
 *  after viewersReady(). */
export function allViewerRows(): { userId: number; profileId: number; rows: ProgressRow[] }[] {
  const out: { userId: number; profileId: number; rows: ProgressRow[] }[] = [];
  for (const v of viewers.values()) {
    const rows = [...v.values()].map(clone);
    if (rows.length) out.push({ userId: rows[0].userId, profileId: rows[0].profileId, rows });
  }
  return out;
}

/** A viewer's rows, most recently updated first (copies). */
export async function recentProgress(userId: number | undefined, profileId: number | undefined, limit: number): Promise<ProgressRow[]> {
  const rows = await progressRows(userId, profileId);
  return rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, limit);
}

// ── writes ─────────────────────────────────────────────────────────────────────

const rowQueue = new Map<string, Promise<unknown>>();
/** Runs `fn` after any earlier write to the same row. */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = rowQueue.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  rowQueue.set(key, next);
  void next.finally(() => { if (rowQueue.get(key) === next) rowQueue.delete(key); });
  return next;
}

/** Saves a position (the PUT /api/user/progress write), then puts the stored row in memory. */
export async function saveProgress(userId: number | undefined, profileId: number | undefined, mediaId: string, progress: number, completed: boolean, meta: any): Promise<void> {
  await viewersReady();
  const key = viewerKey(userId, profileId);
  const where = { userId: userId!, profileId: profileId!, mediaId };
  await serial(`${key}|${mediaId}`, async () => {
    await UserProgress.upsert({ ...where, progress, completed, meta });
    const stored = await UserProgress.findOne({ where });
    let v = viewers.get(key);
    if (!v) viewers.set(key, (v = new Map()));
    const before = v.get(mediaId);
    const after = stored ? (stored.toJSON() as ProgressRow) : undefined;
    if (after) v.set(mediaId, after); else v.delete(mediaId);
    generation++;
    ownGeneration.set(key, (ownGeneration.get(key) ?? 0) + 1);
    if (watchedChanged(before, after)) watchedGeneration++;
  });
  for (const fn of listeners) fn(userId!, profileId!);
}

/** Removes one title from a viewer's history, or all of it when `mediaId` is omitted. */
export async function deleteProgress(userId: number | undefined, profileId: number | undefined, mediaId?: string): Promise<void> {
  await viewersReady();
  const key = viewerKey(userId, profileId);
  await UserProgress.destroy({ where: { userId: userId!, profileId: profileId!, ...(mediaId !== undefined ? { mediaId } : {}) } });
  const v = viewers.get(key);
  const removed = !v ? [] : mediaId !== undefined ? [v.get(mediaId)] : [...v.values()];
  if (v) { if (mediaId !== undefined) v.delete(mediaId); else v.clear(); }
  generation++;
  ownGeneration.set(key, (ownGeneration.get(key) ?? 0) + 1);
  if (removed.some((r) => r && isWatched(r))) watchedGeneration++;
  for (const fn of listeners) fn(userId!, profileId!);
}

/** A title removed from the catalog: its rows go for every viewer. Returns how many. */
export async function deleteProgressForMedia(mediaId: string): Promise<number> {
  const affected = await viewersWith(mediaId);
  const n = await UserProgress.destroy({ where: { mediaId } });
  if (n) await reload(affected);
  return n;
}

/** Duplicate titles merged: rows on the removed id move to the kept one. Returns how many. */
export async function repointProgress(fromMediaId: string, toMediaId: string): Promise<number> {
  const affected = await viewersWith(fromMediaId);
  const [n] = await UserProgress.update({ mediaId: toMediaId }, { where: { mediaId: fromMediaId } });
  if (n) await reload(affected);
  return n || 0;
}

async function viewersWith(mediaId: string): Promise<{ userId: number; profileId: number }[]> {
  await viewersReady();
  const out: { userId: number; profileId: number }[] = [];
  for (const v of viewers.values()) { const r = v.get(mediaId); if (r) out.push({ userId: r.userId, profileId: r.profileId }); }
  return out;
}

/**
 * Watch-progress records that stored a raw upstream stream link (23 on the live server,
 * 2026-10-20: CDN links a browser had received for an episode): sealed in place, so
 * resuming still works and nothing readable is left (infra/sealedCmd.ts).
 */
export async function sealProgressLinks(): Promise<void> {
  const rows = await UserProgress.findAll();
  let sealed = 0;
  for (const row of rows) {
    // Comes back as JSON text on this table; parsed here, written back as an object (the
    // column stringifies it once: writing the text back would encode it twice).
    const stored: any = row.meta;
    let meta: any = stored;
    if (typeof stored === "string") {
      try { meta = JSON.parse(stored); } catch { continue; }
    }
    if (!meta || typeof meta !== "object" || !isUpstreamLink(meta.cmd)) continue;
    row.meta = { ...meta, cmd: sealCmd(meta.cmd) };
    row.changed("meta", true);
    await row.save();
    sealed++;
  }
  logger.info(`[MetaEnrich] progress records: sealed the stream link in ${sealed} of ${rows.length}`);
  if (sealed) await reload();
}

// ── what a progress row says (shared by recommendations and Home rows) ────────

/** A row counts as watching (a taste signal) once this much of it was played, or it is done. */
export const MIN_WATCH_PERCENT = 20;

/** The row's meta as an object (it can come back as JSON text from this table). */
function metaOf(p: any): any {
  let meta = p.meta;
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }
  return meta;
}

/**
 * How much of it was watched, in percent: `meta.progressPercent` (computed by the client at
 * save time), else progress / meta.duration for older rows; null when unknown.
 */
export function watchPercent(p: any): number | null {
  const meta = metaOf(p);
  if (meta && typeof meta.progressPercent === "number") return meta.progressPercent;
  if (meta && typeof meta.duration === "number" && meta.duration > 0 && typeof p.progress === "number") {
    return (p.progress / meta.duration) * 100;
  }
  return null;
}

/** Completed, or watched at least MIN_WATCH_PERCENT: a genuine signal, not an open-and-close. */
export function isWatched(p: any): boolean {
  return !!p.completed || (watchPercent(p) ?? 0) >= MIN_WATCH_PERCENT;
}

/**
 * The catalog id (content_meta id) the client stored in meta.catalogId. mediaId is the
 * portal's playback-file id, which for titles opened from Discover differs from it.
 */
export function catalogIdOf(p: any): string | null {
  const meta = metaOf(p);
  return (meta && typeof meta === "object" && meta.catalogId) || null;
}

/** movie / series: meta.type, else the catalogId prefix; null when unknown. */
export function progressType(p: any): "movie" | "series" | null {
  const meta = metaOf(p);
  if (meta && typeof meta === "object" && (meta.type === "movie" || meta.type === "series")) return meta.type;
  const catalogId = catalogIdOf(p);
  if (catalogId?.startsWith("movie_")) return "movie";
  if (catalogId?.startsWith("series_")) return "series";
  return null;
}

/** Content ids a row may be: its catalogId, else both movie_/series_ guesses. */
export function contentIdsOf(p: any): string[] {
  const catalogId = catalogIdOf(p);
  return catalogId ? [catalogId] : [`movie_${p.mediaId}`, `series_${p.mediaId}`];
}
