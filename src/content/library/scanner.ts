// Scans local libraries (Admin › Libraries) for movies. See docs/skill-local-library.md.
//
// One pass:
//   1. Walk each library folder. A folder whose video files share its name is one title
//      with versions ("Inception (2010)/Inception (2010) - 2160p.mkv"); other video files
//      are one title each. Extras folders and files (trailers, samples) are skipped.
//   2. Files are matched to existing rows by (root, relative path). Only new files and files
//      whose size or modified time changed are probed with ffprobe.
//   3. Titles that are new, renamed or never matched are matched to TMDB and get their
//      catalog row (content_meta "movie_L<id>", category "local").
//   4. Files not seen are marked missing; titles missing for 7 days are removed (watch
//      progress is kept). A library folder that is gone or empty while it had files is
//      skipped instead, so an unplugged disk never empties the library.

import fs from "fs";
import path from "path";
import { Op } from "sequelize";
import { Library } from "@/models/Library";
import { LocalItem } from "@/models/LocalItem";
import { MediaFile, SidecarSubtitle } from "@/models/MediaFile";
import { ContentMeta } from "@/models/ContentMeta";
import { ContentGenre } from "@/models/ContentGenre";
import { ContentCountry } from "@/models/ContentCountry";
import { ContentTheme } from "@/models/ContentTheme";
import { logger } from "@/infra/logger";
import { streamTracker } from "@/services/StreamTracker";
import { enrichLocalTitle, recomputeRepresentatives } from "@/content/metaEnrichment";
import { findTmdbIdByImdb } from "@/content/tmdb";
import { clearDiscoverCache } from "@/services/discoverCache";
import { invalidateDiscoverIndex } from "@/content/discoverIndex";
import { probeFile, resolutionLabel } from "@/content/library/probe";
import {
  EXTRA_DIRS, SUBTITLE_EXTS, isExtraFile, isVideoFile, parseNfo, parseSubtitleName, parseTitle, versionLabelFor,
} from "@/content/library/naming";

const MISSING_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DEPTH = 6;

export function localContentId(itemId: number): string {
  return `movie_L${itemId}`;
}

interface FoundFile { relPath: string; size: number; mtimeMs: number; versionLabel: string | null; sidecars: SidecarSubtitle[] }
interface FoundTitle { relPath: string; name: string; year: string | null; tmdbId: number | null; imdbId: string | null; files: FoundFile[] }

function readDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statOf(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readNfo(p: string) {
  try {
    return parseNfo(fs.readFileSync(p, "utf-8").slice(0, 256 * 1024));
  } catch {
    return null;
  }
}

/** Every title under one library folder. */
function walk(root: string): FoundTitle[] {
  const titles: FoundTitle[] = [];
  const visit = (dir: string, depth: number) => {
    const entries = readDir(dir);
    const videos = entries.filter((e) => e.isFile() && isVideoFile(e.name) && !isExtraFile(e.name) && !e.name.startsWith("."));
    const subs = entries.filter((e) => e.isFile() && SUBTITLE_EXTS.has(path.extname(e.name).toLowerCase()));
    const relDir = path.relative(root, dir);
    const folderBase = path.basename(dir);
    const folderParsed = parseTitle(folderBase);
    const fileBase = (n: string) => path.basename(n, path.extname(n));

    const sidecarsFor = (videoName: string): SidecarSubtitle[] =>
      subs
        .map((s) => {
          const parsed = parseSubtitleName(s.name, fileBase(videoName));
          return parsed
            ? { relPath: path.join(relDir, s.name), language: parsed.language, forced: parsed.forced, format: path.extname(s.name).slice(1).toLowerCase() }
            : null;
        })
        .filter((s): s is SidecarSubtitle => s !== null);

    const fileOf = (e: fs.Dirent, label: string | null): FoundFile | null => {
      const st = statOf(path.join(dir, e.name));
      if (!st) return null;
      return { relPath: path.join(relDir, e.name), size: st.size, mtimeMs: st.mtimeMs, versionLabel: label, sidecars: sidecarsFor(e.name) };
    };

    if (videos.length > 0 && depth > 0) {
      // A movie folder: every video whose name starts with the folder's name is a version.
      const asVersions = videos.filter((v) => versionLabelFor(fileBase(v.name), folderBase) !== null || fileBase(v.name).toLowerCase() === folderBase.toLowerCase());
      const nfo = readNfo(path.join(dir, "movie.nfo")) ?? (videos.length === 1 ? readNfo(path.join(dir, fileBase(videos[0].name) + ".nfo")) : null);
      if (asVersions.length === videos.length || videos.length === 1) {
        const files = videos.map((v) => fileOf(v, videos.length === 1 ? null : versionLabelFor(fileBase(v.name), folderBase))).filter((f): f is FoundFile => !!f);
        const parsed = videos.length === 1 && !folderParsed.year && !folderParsed.tmdbId ? parseTitle(fileBase(videos[0].name)) : folderParsed;
        titles.push({
          relPath: relDir,
          name: nfo?.title || parsed.name,
          year: nfo?.year || parsed.year,
          tmdbId: nfo?.tmdbId ?? parsed.tmdbId,
          imdbId: nfo?.imdbId ?? parsed.imdbId,
          files,
        });
      } else {
        for (const v of videos) {
          const f = fileOf(v, null);
          if (!f) continue;
          const p = parseTitle(fileBase(v.name));
          const own = readNfo(path.join(dir, fileBase(v.name) + ".nfo"));
          titles.push({ relPath: f.relPath, name: own?.title || p.name, year: own?.year || p.year, tmdbId: own?.tmdbId ?? p.tmdbId, imdbId: own?.imdbId ?? p.imdbId, files: [f] });
        }
      }
    } else if (videos.length > 0) {
      // Loose files at the top of the library folder: one title each.
      for (const v of videos) {
        const f = fileOf(v, null);
        if (!f) continue;
        const p = parseTitle(fileBase(v.name));
        const own = readNfo(path.join(dir, fileBase(v.name) + ".nfo"));
        titles.push({ relPath: f.relPath, name: own?.title || p.name, year: own?.year || p.year, tmdbId: own?.tmdbId ?? p.tmdbId, imdbId: own?.imdbId ?? p.imdbId, files: [f] });
      }
    }

    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || EXTRA_DIRS.has(e.name.toLowerCase())) continue;
      visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  return titles;
}

async function waitWhileWatching(): Promise<void> {
  // Probing reads the disks: let someone's film go first (checked between files).
  let waited = 0;
  while (streamTracker.count() > 0 && waited < 30 * 60_000) {
    await new Promise((r) => setTimeout(r, 15_000));
    waited += 15_000;
  }
}

export interface ScanSummary {
  titles: number;
  added: number;
  probed: number;
  matched: number;
  unmatched: number;
  missing: number;
  removed: number;
  skippedFolders: string[];
}

let scanning = false;
export function isScanning(): boolean {
  return scanning;
}

/** Scans one library (or all enabled ones). Returns a one-line summary. */
export async function scanLibraries(onlyId?: number): Promise<string> {
  if (scanning) return "a scan is already running";
  scanning = true;
  try {
    const libs = await Library.findAll({ where: onlyId ? { id: onlyId } : { enabled: true } });
    const lines: string[] = [];
    for (const lib of libs) {
      const s = await scanOne(lib);
      const line =
        `${lib.name}: ${s.titles} titles, ${s.added} new, ${s.probed} probed, ${s.matched} matched, ${s.unmatched} unmatched` +
        (s.missing ? `, ${s.missing} missing` : "") + (s.removed ? `, ${s.removed} removed` : "") +
        (s.skippedFolders.length ? `; skipped (not reachable): ${s.skippedFolders.join(", ")}` : "");
      lib.lastScanAt = new Date();
      lib.lastScanSummary = line;
      await lib.save();
      lines.push(line);
      logger.info(`[library] ${line}`);
    }
    if (libs.length) {
      await recomputeRepresentatives();
      invalidateDiscoverIndex();
      clearDiscoverCache();
    }
    return lines.join(" | ") || "no libraries";
  } finally {
    scanning = false;
  }
}

async function scanOne(lib: Library): Promise<ScanSummary> {
  const sum: ScanSummary = { titles: 0, added: 0, probed: 0, matched: 0, unmatched: 0, missing: 0, removed: 0, skippedFolders: [] };
  const seenFileIds = new Set<number>();
  const seenItemIds = new Set<number>();
  const scannedRoots: string[] = [];

  for (const root of lib.folders || []) {
    const known = await MediaFile.count({ where: { libraryId: lib.id, root } });
    const st = statOf(root);
    const found = st?.isDirectory() ? walk(root) : [];
    if (found.length === 0 && known > 0) {
      // Folder gone or empty although it had files: a disk is probably offline.
      sum.skippedFolders.push(root);
      continue;
    }
    scannedRoots.push(root);

    for (const t of found) {
      sum.titles++;
      let item = await LocalItem.findOne({ where: { libraryId: lib.id, root, relPath: t.relPath } });
      const nameChanged = item && (item.name !== t.name || (item.year ?? null) !== (t.year ?? null) || (item.tmdbIdHint ?? null) !== (t.tmdbId ?? null));
      if (!item) {
        item = await LocalItem.create({ libraryId: lib.id, kind: "movie", root, relPath: t.relPath, name: t.name, year: t.year, tmdbIdHint: t.tmdbId, missingSince: null });
        sum.added++;
      } else if (nameChanged || item.missingSince) {
        Object.assign(item, { name: t.name, year: t.year, tmdbIdHint: t.tmdbId, missingSince: null });
        if (nameChanged) item.matchedAt = null;
        await item.save();
      }
      seenItemIds.add(item.id);

      for (const f of t.files) {
        let row = await MediaFile.findOne({ where: { libraryId: lib.id, root, relPath: f.relPath } });
        const changed = !row || row.size !== f.size || Math.abs(row.mtimeMs - f.mtimeMs) > 1;
        if (!row) {
          row = await MediaFile.create({ itemId: item.id, libraryId: lib.id, root, relPath: f.relPath, size: f.size, mtimeMs: f.mtimeMs, versionLabel: f.versionLabel, sidecars: f.sidecars, missingSince: null });
        } else {
          Object.assign(row, { itemId: item.id, size: f.size, mtimeMs: f.mtimeMs, sidecars: f.sidecars, missingSince: null });
          if (f.versionLabel) row.versionLabel = f.versionLabel;
        }
        if (changed || !row.probedAt) {
          await waitWhileWatching();
          try {
            const p = await probeFile(path.join(root, f.relPath));
            Object.assign(row, { ...p, probedAt: new Date(), probeError: null });
            if (!f.versionLabel) row.versionLabel = resolutionLabel(p.width, p.height);
          } catch (e: any) {
            row.probeError = String(e?.message ?? e).slice(0, 300);
            row.probedAt = new Date();
          }
          sum.probed++;
        }
        await row.save();
        seenFileIds.add(row.id);
      }

      // Match titles that are new, renamed, or not matched yet (a later scan retries
      // unmatched ones once a day at most).
      const retryDue = !item.matchedTmdbId && (!item.matchedAt || Date.now() - item.matchedAt.getTime() > 24 * 3600_000);
      if (!item.matchedAt || retryDue) {
        try {
          let tmdbId = item.tmdbIdLocked ?? item.tmdbIdHint ?? null;
          if (!tmdbId && t.imdbId) tmdbId = await findTmdbIdByImdb(t.imdbId, "movie");
          const matched = await enrichLocalTitle({ contentId: localContentId(item.id), type: "movie", name: item.name, year: item.year, tmdbId });
          item.matchedTmdbId = matched ?? null;
          item.matchedAt = new Date();
          await item.save();
        } catch (e: any) {
          logger.warn(`[library] could not match "${item.name}": ${e?.message ?? e}`);
        }
      }
      if (item.matchedTmdbId) sum.matched++;
      else sum.unmatched++;
    }
  }

  // Missing files and titles, only under folders that were actually scanned.
  if (scannedRoots.length) {
    const now = new Date();
    const gone = await MediaFile.findAll({ where: { libraryId: lib.id, root: { [Op.in]: scannedRoots }, missingSince: null } });
    for (const f of gone) {
      if (seenFileIds.has(f.id)) continue;
      f.missingSince = now;
      await f.save();
      sum.missing++;
    }
    const items = await LocalItem.findAll({ where: { libraryId: lib.id, root: { [Op.in]: scannedRoots } } });
    for (const it of items) {
      if (seenItemIds.has(it.id)) continue;
      if (!it.missingSince) {
        it.missingSince = now;
        await it.save();
      } else if (now.getTime() - it.missingSince.getTime() > MISSING_GRACE_MS) {
        await removeItem(it);
        sum.removed++;
      }
    }
  }
  return sum;
}

/** Removes a local title and its catalog row. Watch progress is kept. */
export async function removeItem(item: LocalItem): Promise<void> {
  const contentId = localContentId(item.id);
  await MediaFile.destroy({ where: { itemId: item.id } });
  await ContentGenre.destroy({ where: { contentId } });
  await ContentCountry.destroy({ where: { contentId } });
  await ContentTheme.destroy({ where: { contentId } });
  await ContentMeta.destroy({ where: { id: contentId } });
  await item.destroy();
}

/** Removes everything a deleted library had. */
export async function removeLibraryContent(libraryId: number): Promise<void> {
  const items = await LocalItem.findAll({ where: { libraryId } });
  for (const it of items) await removeItem(it);
  await recomputeRepresentatives();
  invalidateDiscoverIndex();
  clearDiscoverCache();
}

/** "Fix match": pin a title to a TMDB id (null = forget the pin) and match it again now. */
export async function fixMatch(itemId: number, tmdbId: number | null): Promise<LocalItem | null> {
  const item = await LocalItem.findByPk(itemId);
  if (!item) return null;
  item.tmdbIdLocked = tmdbId;
  const matched = await enrichLocalTitle({ contentId: localContentId(item.id), type: "movie", name: item.name, year: item.year, tmdbId: tmdbId ?? item.tmdbIdHint });
  item.matchedTmdbId = matched ?? null;
  item.matchedAt = new Date();
  await item.save();
  await recomputeRepresentatives();
  invalidateDiscoverIndex();
  clearDiscoverCache();
  return item;
}
