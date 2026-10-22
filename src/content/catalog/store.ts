// Catalog snapshot lifecycle (plan, Phase 1): load or build, watch the change log, rebuild,
// swap, save. Behind the `catalogSnapshot` setting (off by default) until Phase 1b moves the
// routes onto it: running beside today's in-memory views would cost ~160 MB more on a 1 GB
// container, so it goes live together with the readers that let those views be retired.
//
// Phase 1 rebuilds on change (merged: 60 s after the last change, at most every 10 min); the
// overlay that applies small changes without a rebuild comes with the readers in Phase 1b.

import path from "path";
import { sequelize } from "@/db";
import { dataDir, databasePath } from "@/infra/paths";
import { logger } from "@/infra/logger";
import { setting } from "@/config/settings";
import { readGenres } from "@/infra/storage";
import { buildSnapshot, type ColumnSpec } from "./builder";
import { CatalogSnapshot } from "./snapshot";
import { setChangeCapture, latestChange, pruneChanges } from "./changes";
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

/** The snapshot in use, or null (off, or not built yet). Callers take it once per request. */
export function catalogSnapshot(): CatalogSnapshot | null {
  return current;
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
    const out = await buildSnapshot({
      dbPath: databasePath,
      copyColumns: COPY_COLUMNS,
      genres: { movie: await genreIds("movie"), series: await genreIds("series") },
    });
    const builtAt = new Date().toISOString();
    const swapStart = performance.now();
    current = new CatalogSnapshot(out.version, builtAt, out.counts, out.sections);
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
  await setChangeCapture(sequelize, on);
  if (!on) return;
  const dbVersion = await latestChange(sequelize);
  const saved = (await listSnapshotFiles(DIR()))[0];
  if (saved) {
    const t0 = Date.now();
    try {
      const { header, sections } = await readSnapshotFile(saved.file);
      current = new CatalogSnapshot(header.version, header.builtAt, header.counts, sections);
      lastBuildAt = Date.now();
      lastStatus = { loadedFrom: path.basename(saved.file), loadMs: Date.now() - t0, sizeMb: Math.round(current.bytes / 104857.6) / 10, counts: header.counts };
      logger.info(`[catalog] loaded ${path.basename(saved.file)} in ${Date.now() - t0} ms (database at v${dbVersion})`);
    } catch (e: any) {
      logger.warn(`[catalog] saved snapshot not usable (${e?.message ?? e}); building a new one`);
    }
  }
  if (!current || current.version < dbVersion) await rebuildCatalogSnapshot(current ? "stale file" : "start");
  pollTimer = setInterval(() => void poll(), POLL_MS);
  pollTimer.unref?.();
}
