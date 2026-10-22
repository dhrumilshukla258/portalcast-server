// Catalog snapshot lifecycle (plan, Phase 1): load or build, watch the change log, rebuild,
// swap, save. Behind the `catalogSnapshot` setting (off by default) until Phase 1b moves the
// routes onto it: running beside today's in-memory views would cost ~160 MB more on a 1 GB
// container, so it goes live together with the readers that let those views be retired.
//
// Rebuilds on change (merged: 60 s after the last change, at most every 10 min). Between
// rebuilds, readers check each category list against the cache version the snapshot matches
// (listMatchesSnapshot) and read a changed list from the cache instead (catalog/views.ts).

import path from "path";
import { sequelize } from "@/db";
import { dataDir, databasePath } from "@/infra/paths";
import { logger } from "@/infra/logger";
import { setting } from "@/config/settings";
import { readGenres } from "@/infra/storage";
import { buildSnapshot, type ColumnSpec } from "./builder";
import { CatalogSnapshot } from "./snapshot";
import { setChangeCapture, latestChange, pruneChanges, listChangesSince, changesSince } from "./changes";
import { xtreamCacheKeyVersion } from "@/services/xtreamCache";
import { listSnapshotFiles, readSnapshotFile, writeSnapshotFile } from "./format";

/** content_meta columns the snapshot holds (bookkeeping timestamps left out). */
export const COPY_COLUMNS: ColumnSpec[] = [
  ...["id", "type", "name", "trimmedName", "year", "groupKey", "originalLanguage", "poster", "backdrop", "backdropHd",
    "logo", "portalCategoryId", "cast", "director", "overview", "imdbId", "rtRating", "tagline", "ageRating", "studios",
    "collection", "originalTitle", "premiered", "writers", "trailerKey", "source", "artLocked"]
    .map((name) => ({ name, kind: "text" as const })),
  { name: "enrichedAt", kind: "date" }, // epoch ms: 132k distinct timestamps cost 3.8 MB as text
  ...["tmdbId", "isRepresentative", "rating", "ratingCount", "imdbRating", "imdbVotes", "metascore", "runtime"]
    .map((name) => ({ name, kind: "num" as const })),
];

const DIR = () => path.join(dataDir, "catalog");
const POLL_MS = 5_000;
const QUIET_MS = 60_000;
const MIN_REBUILD_MS = 10 * 60_000;

let current: CatalogSnapshot | null = null;
let building = false;
let lastBuildAt = 0;
let pendingSince = 0;
let pollTimer: NodeJS.Timeout | null = null;
let lastStatus: Record<string, unknown> = {};
/** Per category list cache key: the xtreamCache write version the current snapshot holds. */
let listVersions = new Map<string, string>();

/** The snapshot in use, or null (off, or not built yet). Callers take it once per request. */
export function catalogSnapshot(): CatalogSnapshot | null {
  return current;
}

let markReady: (snap: CatalogSnapshot | null) => void = () => undefined;
const ready = new Promise<CatalogSnapshot | null>((resolve) => { markReady = resolve; });

/** Resolves once start-up has a snapshot (from its file or a first build), or null when it is
 *  off or could not be built; readers wait on it instead of building the views it replaces. */
export function catalogReady(): Promise<CatalogSnapshot | null> {
  return ready;
}

/** Keys written after the snapshot was built, per log table ("title", "tags", "person"...). */
export interface CatalogChanges {
  snap: CatalogSnapshot;
  keys: Map<string, Set<string>>;
  has(tbl: string, key: string): boolean;
}

let changeState: { snap: CatalogSnapshot; seq: number; keys: Map<string, Set<string>> } | null = null;
let changeSync: Promise<void> | null = null;

/**
 * What changed since the current snapshot: one indexed read of the change log per call,
 * returning only rows newer than the last call, so a write made a moment ago is seen
 * (readers serve those keys from the database). Null when there is no snapshot.
 */
export async function catalogChanges(): Promise<CatalogChanges | null> {
  const snap = current;
  if (!snap) return null;
  if (!changeState || changeState.snap !== snap) changeState = { snap, seq: snap.version, keys: new Map() };
  const state = changeState;
  // Concurrent requests share one read; a request arriving after it started reads again, so
  // it never misses a write it made before asking.
  const read = (async () => {
    if (changeSync) await changeSync.catch(() => undefined);
    for (;;) {
      const rows = await changesSince(sequelize, state.seq);
      for (const r of rows) {
        let set = state.keys.get(r.tbl);
        if (!set) state.keys.set(r.tbl, (set = new Set()));
        set.add(r.key);
        if (r.seq > state.seq) state.seq = r.seq;
      }
      if (rows.length < 5000) break; // changesSince returns at most 5000 rows per call
    }
  })();
  changeSync = read;
  await read;
  if (changeSync === read) changeSync = null;
  return { snap, keys: state.keys, has: (tbl, key) => !!state.keys.get(tbl)?.has(key) };
}

/** The cache list under `key`, at cache version `version`, is the one in the snapshot. */
export function listMatchesSnapshot(key: string, version: string): boolean {
  return listVersions.get(key) === version;
}

/** A changed list was read and found equal to the snapshot's (a refresh that changed nothing). */
export function markListMatches(snap: CatalogSnapshot, key: string, version: string): void {
  if (snap === current) listVersions.set(key, version);
}

const listKeyOf = (type: "movie" | "series", id: string) => (type === "movie" ? `vod_streams_${id}` : `series_list_${id}`);

/** Versions of the snapshot's lists, read before its data: a write after this reads as a change. */
function snapshotListKeys(snap: CatalogSnapshot): string[] {
  const keys: string[] = [];
  for (let c = 0; c < snap.listCategoryCount; c++) { const cat = snap.listCategory(c); keys.push(listKeyOf(cat.type, cat.id)); }
  return keys;
}

export function catalogStatus(): Record<string, unknown> {
  return { enabled: !!setting<boolean>("catalogSnapshot"), version: current?.version ?? null, ...lastStatus };
}

async function genreIds(type: "movie" | "series"): Promise<string[]> {
  const { getActiveProfileId } = await import("@/routes/stalkerV2/shared");
  const genres = await readGenres(type, await getActiveProfileId());
  return genres.map((g: any) => String(g.id)).filter((id: string) => id && id !== "*");
}

/** Builds a new snapshot in a worker, swaps it in, saves it. */
export async function rebuildCatalogSnapshot(reason: string): Promise<void> {
  if (building) return;
  building = true;
  pendingSince = 0;
  const t0 = Date.now();
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  sampler.unref?.();
  try {
    const genres = { movie: await genreIds("movie"), series: await genreIds("series") };
    // Recorded before the worker opens its read transaction: a list written after this point
    // has a newer version and is read from the cache until the next rebuild.
    const versions = new Map<string, string>();
    for (const type of ["movie", "series"] as const) for (const id of genres[type]) versions.set(listKeyOf(type, id), xtreamCacheKeyVersion(listKeyOf(type, id)));
    const out = await buildSnapshot({
      dbPath: databasePath,
      copyColumns: COPY_COLUMNS,
      genres,
    });
    const builtAt = new Date().toISOString();
    const swapStart = performance.now();
    current = new CatalogSnapshot(out.version, builtAt, out.counts, out.sections);
    listVersions = versions;
    const swapMs = performance.now() - swapStart;
    lastBuildAt = Date.now();
    clearInterval(sampler);
    const mb = current.bytes / 1048576;
    lastStatus = {
      builtAt, reason, buildMs: lastBuildAt - t0, readMs: out.readMs, swapMs: Math.round(swapMs * 10) / 10,
      peakMbOverStart: Math.round((peak - rss0) / 1048576), workerHeapMb: out.heapMb, stages: out.stages, sizeMb: Math.round(mb * 10) / 10, counts: out.counts,
    };
    logger.info(
      `[catalog] snapshot v${out.version} (${reason}): ${out.counts.copies} copies, ${out.counts.people} people, ${out.counts.credits} credits, ` +
      `${out.counts.listItems} list entries, ${out.counts.strings} distinct strings; ${mb.toFixed(1)} MB; built in ${lastBuildAt - t0} ms ` +
      `(worker heap ${out.heapMb} MB, peak +${lastStatus.peakMbOverStart} MB, swap ${lastStatus.swapMs} ms)`,
    );
    // Saved without blocking; the older files are removed after the new one is complete.
    const file = await writeSnapshotFile(DIR(), { version: out.version, builtAt, checksum: out.checksum, counts: out.counts }, out.sections);
    for (const old of (await listSnapshotFiles(DIR())).slice(1)) await import("fs").then((fs) => fs.promises.rm(old.file, { force: true }));
    logger.info(`[catalog] saved ${path.basename(file)}`);
    await pruneChanges(sequelize).catch(() => undefined);
  } catch (e: any) {
    clearInterval(sampler);
    logger.warn(`[catalog] snapshot build failed (${reason}); keeping the previous one: ${e?.message ?? e}`);
  } finally {
    building = false;
  }
}

async function poll(): Promise<void> {
  if (building) return;
  let v: number;
  try { v = await latestChange(sequelize); } catch { return; }
  if (current && v <= current.version) { pendingSince = 0; return; }
  const now = Date.now();
  if (!pendingSince) pendingSince = now;
  // Rebuild once the changes have stopped for a minute, and not more often than every 10 min.
  if (now - pendingSince >= QUIET_MS && now - lastBuildAt >= MIN_REBUILD_MS) await rebuildCatalogSnapshot("changes");
}

/** Called once after start. Off: removes the change log and its triggers. */
export async function startCatalogSnapshot(): Promise<void> {
  const on = !!setting<boolean>("catalogSnapshot");
  try {
    await setChangeCapture(sequelize, on);
    if (on) await loadOrBuild();
  } finally {
    markReady(current);
  }
  if (!on) return;
  // A file older than the database is served (lists are checked per request, see views.ts)
  // while a current one is built.
  if (current && current.version < (await latestChange(sequelize))) void rebuildCatalogSnapshot("stale file");
  pollTimer = setInterval(() => void poll(), POLL_MS);
  pollTimer.unref?.();
}

async function loadOrBuild(): Promise<void> {
  const dbVersion = await latestChange(sequelize);
  const saved = (await listSnapshotFiles(DIR()))[0];
  if (saved) {
    const t0 = Date.now();
    try {
      const { header, sections } = await readSnapshotFile(saved.file);
      const loaded = new CatalogSnapshot(header.version, header.builtAt, header.counts, sections);
      // Versions first, then the log: a list written in between is caught by one or the other.
      const versions = new Map<string, string>();
      for (const key of snapshotListKeys(loaded)) versions.set(key, xtreamCacheKeyVersion(key));
      for (const key of await listChangesSince(sequelize, header.version)) versions.delete(key);
      current = loaded;
      listVersions = versions;
      lastBuildAt = Date.now();
      lastStatus = { loadedFrom: path.basename(saved.file), loadMs: Date.now() - t0, sizeMb: Math.round(current.bytes / 104857.6) / 10, counts: header.counts };
      logger.info(`[catalog] loaded ${path.basename(saved.file)} in ${Date.now() - t0} ms (database at v${dbVersion})`);
    } catch (e: any) {
      logger.warn(`[catalog] saved snapshot not usable (${e?.message ?? e}); building a new one`);
    }
  }
  if (!current) await rebuildCatalogSnapshot("start");
}
