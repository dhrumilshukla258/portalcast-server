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

import { parseNfoFull, type NfoData } from "@/content/library/nfo";
import { ContentPerson } from "@/models/ContentPerson";
import { findArt, artMarker } from "@/content/library/art";
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
  parseEpisode, seasonFromFolder,
} from "@/content/library/naming";

const MISSING_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DEPTH = 6;

/** The catalog row of a local title: "movie_L<id>" or "series_L<id>". */
export function localContentId(itemId: number, kind: string = "movie"): string {
  return `${kind === "series" ? "series" : "movie"}_L${itemId}`;
}

interface FoundFile {
  relPath: string; size: number; mtimeMs: number; versionLabel: string | null; sidecars: SidecarSubtitle[];
  season?: number | null; episode?: number | null; episodeEnd?: number | null; episodeTitle?: string | null;
  nfo?: MediaFile["nfo"]; thumb?: string | null;
}
interface FoundTitle { relPath: string; name: string; year: string | null; tmdbId: number | null; imdbId: string | null; files: FoundFile[]; nfo?: NfoData | null }

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

/** A Kodi/Jellyfin NFO file, fully parsed (content/library/nfo.ts), or null. */
function readNfo(p: string): NfoData | null {
  try {
    return parseNfoFull(fs.readFileSync(p, "utf-8").slice(0, 512 * 1024));
  } catch {
    return null;
  }
}

/** Jellyfin keeps an episode's thumbnail in metadata/<file>.jpg; Kodi beside it as <file>-thumb.jpg. */
function episodeThumb(dir: string, base: string, relDir: string): string | null {
  for (const rel of [path.join("metadata", base + ".jpg"), base + "-thumb.jpg", base + ".jpg", path.join("metadata", base + ".png")]) {
    if (statOf(path.join(dir, rel))?.isFile()) return path.join(relDir, rel);
  }
  return null;
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
          nfo,
        });
      } else {
        for (const v of videos) {
          const f = fileOf(v, null);
          if (!f) continue;
          const p = parseTitle(fileBase(v.name));
          const own = readNfo(path.join(dir, fileBase(v.name) + ".nfo"));
          titles.push({ relPath: f.relPath, name: own?.title || p.name, year: own?.year || p.year, tmdbId: own?.tmdbId ?? p.tmdbId, imdbId: own?.imdbId ?? p.imdbId, files: [f], nfo: own });
        }
      }
    } else if (videos.length > 0) {
      // Loose files at the top of the library folder: one title each.
      for (const v of videos) {
        const f = fileOf(v, null);
        if (!f) continue;
        const p = parseTitle(fileBase(v.name));
        const own = readNfo(path.join(dir, fileBase(v.name) + ".nfo"));
        titles.push({ relPath: f.relPath, name: own?.title || p.name, year: own?.year || p.year, tmdbId: own?.tmdbId ?? p.tmdbId, imdbId: own?.imdbId ?? p.imdbId, files: [f], nfo: own });
      }
    }

    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      // Jellyfin's trickplay thumbnails ("<video>.trickplay") and extras folders hold no titles.
      if (!e.isDirectory() || e.name.startsWith(".") || e.name.toLowerCase().endsWith(".trickplay") || EXTRA_DIRS.has(e.name.toLowerCase())) continue;
      visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  return titles;
}

/** Every show under one series library folder: each top-level folder is a show. */
function walkSeries(root: string): FoundTitle[] {
  const shows: FoundTitle[] = [];
  for (const showDir of readDir(root)) {
    if (!showDir.isDirectory() || showDir.name.startsWith(".") || EXTRA_DIRS.has(showDir.name.toLowerCase())) continue;
    const showPath = path.join(root, showDir.name);
    const parsed = parseTitle(showDir.name);
    const nfo = readNfo(path.join(showPath, "tvshow.nfo"));
    const files: FoundFile[] = [];
    const visit = (dir: string, depth: number, seasonHint: number | null) => {
      const entries = readDir(dir);
      const subs = entries.filter((e) => e.isFile() && SUBTITLE_EXTS.has(path.extname(e.name).toLowerCase()));
      for (const e of entries) {
        if (!e.isFile() || !isVideoFile(e.name) || isExtraFile(e.name) || e.name.startsWith(".")) continue;
        const base = path.basename(e.name, path.extname(e.name));
        const ep = parseEpisode(base, seasonHint);
        if (!ep) continue; // not an episode (no SxxEyy and no season folder): left out
        const st = statOf(path.join(dir, e.name));
        if (!st) continue;
        const relDir = path.relative(root, dir);
        const epNfo = readNfo(path.join(dir, base + ".nfo"));
        files.push({
          relPath: path.join(relDir, e.name), size: st.size, mtimeMs: st.mtimeMs, versionLabel: null,
          sidecars: subs
            .map((sb) => {
              const ps = parseSubtitleName(sb.name, base);
              return ps ? { relPath: path.join(relDir, sb.name), language: ps.language, forced: ps.forced, format: path.extname(sb.name).slice(1).toLowerCase() } : null;
            })
            .filter((x): x is SidecarSubtitle => x !== null),
          season: ep.season ?? seasonHint ?? 1, episode: ep.episode, episodeEnd: ep.episodeEnd,
          // The episode's NFO title beats what the file name says (often nothing useful).
          episodeTitle: epNfo?.title || ep.title,
          nfo: epNfo ? { title: epNfo.title, plot: epNfo.plot, rating: epNfo.rating, premiered: epNfo.premiered, runtime: epNfo.runtime, directors: epNfo.directors } : null,
          thumb: episodeThumb(dir, base, relDir),
        });
      }
      if (depth >= 4) return;
      for (const e of entries) {
        // Jellyfin's metadata/ (episode thumbnails) and trickplay folders hold no episodes.
        if (!e.isDirectory() || e.name.startsWith(".") || e.name.toLowerCase() === "metadata" || e.name.toLowerCase().endsWith(".trickplay")) continue;
        const season = seasonFromFolder(e.name);
        if (season === null && EXTRA_DIRS.has(e.name.toLowerCase())) continue;
        visit(path.join(dir, e.name), depth + 1, season ?? seasonHint);
      }
    };
    visit(showPath, 0, null);
    if (files.length === 0) continue;
    shows.push({
      relPath: showDir.name,
      name: nfo?.title || parsed.name,
      year: nfo?.year || parsed.year,
      tmdbId: nfo?.tmdbId ?? parsed.tmdbId,
      imdbId: nfo?.imdbId ?? parsed.imdbId,
      files,
      nfo,
    });
  }
  return shows;
}

let waitLogged = 0;
async function waitWhileWatching(): Promise<void> {
  // Probing reads the disks: let someone's film go first (checked between files), for at
  // most 2 minutes per file, so a scan still finishes while someone watches all evening.
  let waited = 0;
  while (streamTracker.count() > 0 && waited < 2 * 60_000) {
    if (Date.now() - waitLogged > 10 * 60_000) {
      waitLogged = Date.now();
      logger.info("[library] someone is watching: the scan probes files more slowly until playback stops");
    }
    await new Promise((r) => setTimeout(r, 15_000));
    waited += 15_000;
  }
}

/**
 * Artwork beside a title (Jellyfin's folder.jpg, backdrop.jpg, logo.png) wins over TMDB's:
 * the catalog row's poster/backdrop point at it (content/library/art.ts). Run after every
 * match, since matching writes TMDB's images back.
 */
async function applyFolderArt(item: LocalItem): Promise<void> {
  const dir = path.join(item.root, item.relPath);
  const st = statOf(dir);
  const art = st?.isDirectory() ? findArt(dir) : null;
  if (JSON.stringify(art ?? null) !== JSON.stringify(item.art ?? null)) {
    item.art = art;
    await item.save();
  }
  if (!art) return;
  const contentId = localContentId(item.id, item.kind);
  const meta = await ContentMeta.findByPk(contentId, { attributes: ["id", "poster", "backdrop", "backdropHd"] });
  if (!meta) return;
  const want: Record<string, string> = {};
  if (art.poster) want.poster = artMarker(item.id, "poster", art.v);
  if (art.backdrop) want.backdrop = want.backdropHd = artMarker(item.id, "backdrop", art.v);
  const changed = Object.entries(want).some(([k, v]) => (meta as any)[k] !== v);
  if (changed) await ContentMeta.update(want, { where: { id: contentId } });
}

/**
 * A title's NFO (Jellyfin's or Kodi's) as a metadata source: it fills whatever TMDB did not
 * give (description, cast, crew, genres, countries, age rating, tagline, runtime, studios,
 * collection, IMDb id), and a locked NFO ("lockdata", your edits in Jellyfin) wins over TMDB.
 * Folder art stays the logo when there is one. Run after every match and art pass.
 */
async function applyNfoMeta(item: LocalItem): Promise<void> {
  const nfo = item.nfo as NfoData | null;
  if (!nfo) return;
  const contentId = localContentId(item.id, item.kind);
  const meta = await ContentMeta.findByPk(contentId);
  if (!meta) return;
  const locked = nfo.locked;
  const fill = (field: keyof ContentMeta, value: any) => (locked || !(meta as any)[field]) && value != null && value !== "";
  const patch: Record<string, any> = {};
  if (fill("overview", nfo.plot)) patch.overview = nfo.plot;
  const cast = nfo.actors.slice(0, 8).map((a) => a.name).join(", ");
  if (fill("cast", cast)) patch.cast = cast;
  const crew = item.kind === "series" ? null : nfo.directors.join(", ");
  if (crew && fill("director", crew)) patch.director = crew;
  if (fill("imdbId", nfo.imdbId)) patch.imdbId = nfo.imdbId;
  if (fill("tagline", nfo.tagline)) patch.tagline = nfo.tagline;
  if (fill("ageRating", nfo.mpaa)) patch.ageRating = nfo.mpaa;
  if (fill("runtime", nfo.runtime)) patch.runtime = nfo.runtime;
  if (fill("studios", nfo.studios.join(", "))) patch.studios = nfo.studios.slice(0, 4).join(", ");
  if (fill("collection", nfo.collection)) patch.collection = nfo.collection;
  if (fill("originalTitle", nfo.originalTitle)) patch.originalTitle = nfo.originalTitle;
  if (fill("premiered", nfo.premiered)) patch.premiered = nfo.premiered;
  if (fill("writers", nfo.writers.join(", "))) patch.writers = nfo.writers.slice(0, 6).join(", ");
  if (!meta.rating && nfo.rating) patch.rating = nfo.rating;
  if (item.art?.logo) patch.logo = artMarker(item.id, "logo", item.art.v);
  if (Object.keys(patch).length) await ContentMeta.update(patch, { where: { id: contentId } });

  // Cast and crew: from the NFO when TMDB gave none, or when the NFO is locked.
  const people = await ContentPerson.count({ where: { contentId } });
  if ((people === 0 || locked) && (nfo.actors.length || nfo.directors.length)) {
    await ContentPerson.destroy({ where: { contentId } });
    await ContentPerson.bulkCreate([
      ...nfo.actors.slice(0, 20).map((a, i) => ({ contentId, kind: "cast", name: a.name, role: a.role, sortOrder: i, tmdbPersonId: null, photo: null })),
      ...nfo.directors.map((n, i) => ({ contentId, kind: "director", name: n, role: null, sortOrder: i, tmdbPersonId: null, photo: null })),
      ...nfo.writers.slice(0, 6).map((n, i) => ({ contentId, kind: "writer", name: n, role: null, sortOrder: i, tmdbPersonId: null, photo: null })),
    ]);
  }
  // Genres and countries: from the NFO when the title has none (or the NFO is locked).
  for (const [Model, values] of [[ContentGenre, nfo.genres], [ContentCountry, nfo.countries]] as const) {
    if (!values.length) continue;
    const have = await (Model as any).count({ where: { contentId } });
    if (have === 0 || locked) {
      await (Model as any).destroy({ where: { contentId } });
      await (Model as any).bulkCreate(values.map((value: string) => ({ contentId, value, isRepresentative: false })));
    }
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
/** Libraries asked for while a scan runs ("all" = every library); scanned right after it. */
const pending = new Set<number | "all">();
export function isScanning(): boolean {
  return scanning;
}

/** Scans one library (or all enabled ones). Returns a one-line summary. */
export async function scanLibraries(onlyId?: number): Promise<string> {
  if (scanning) {
    pending.add(onlyId ?? "all");
    return "queued: a scan is running, this one follows it";
  }
  scanning = true;
  try {
    return await scanNow(onlyId);
  } finally {
    scanning = false;
    // Scans asked for meanwhile (a second library added during the first scan).
    if (pending.size) {
      const next = pending.has("all") ? undefined : (pending.values().next().value as number);
      if (next === undefined) pending.clear(); else pending.delete(next);
      setTimeout(() => void scanLibraries(next).catch((e) => logger.error(`[library] queued scan failed: ${e?.message ?? e}`)), 0);
    }
  }
}

/**
 * Retries a write that met "database is locked": the metadata backfills write all the time,
 * and SQLite has one writer, so a big write (like re-picking every title's card) can find
 * the lock taken for longer than the 5 s wait. A few spaced retries get through.
 */
async function withBusyRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const busy = /SQLITE_BUSY|database is locked/i.test(String(e?.message ?? e));
      if (!busy || attempt >= 6) throw e;
      logger.warn(`[library] ${what}: database busy, retrying (${attempt})`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}

async function scanNow(onlyId?: number): Promise<string> {
  {
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
      await withBusyRetry("saving the scan result", () => lib.save());
      lines.push(line);
      logger.info(`[library] ${line}`);
    }
    if (libs.length) {
      await withBusyRetry("updating Discover", () => recomputeRepresentatives());
      invalidateDiscoverIndex();
      clearDiscoverCache();
    }
    return lines.join(" | ") || "no libraries";
  }
}

async function scanOne(lib: Library): Promise<ScanSummary> {
  const kind = lib.kind === "series" ? "series" : "movie";
  const sum: ScanSummary = { titles: 0, added: 0, probed: 0, matched: 0, unmatched: 0, missing: 0, removed: 0, skippedFolders: [] };
  const seenFileIds = new Set<number>();
  const seenItemIds = new Set<number>();
  const scannedRoots: string[] = [];

  for (const root of lib.folders || []) {
    const known = await MediaFile.count({ where: { libraryId: lib.id, root } });
    const st = statOf(root);
    const found = st?.isDirectory() ? (kind === "series" ? walkSeries(root) : walk(root)) : [];
    logger.info(`[library] ${lib.name}: ${found.length} ${kind === "series" ? "shows" : "titles"} found in ${root}, ${found.reduce((n, t) => n + t.files.length, 0)} files`);
    if (found.length === 0 && known > 0) {
      // Folder gone or empty although it had files: a disk is probably offline.
      sum.skippedFolders.push(root);
      continue;
    }
    scannedRoots.push(root);

    for (const t of found) {
      sum.titles++;
      if (sum.titles % 50 === 0) logger.info(`[library] ${lib.name}: ${sum.titles}/${found.length} done (${sum.probed} files probed so far)`);
      let item = await LocalItem.findOne({ where: { libraryId: lib.id, root, relPath: t.relPath } });
      const nameChanged = item && (item.name !== t.name || (item.year ?? null) !== (t.year ?? null) || (item.tmdbIdHint ?? null) !== (t.tmdbId ?? null));
      if (!item) {
        item = await LocalItem.create({ libraryId: lib.id, kind, root, relPath: t.relPath, name: t.name, year: t.year, tmdbIdHint: t.tmdbId, missingSince: null });
        sum.added++;
      } else if (nameChanged || item.missingSince) {
        Object.assign(item, { name: t.name, year: t.year, tmdbIdHint: t.tmdbId, missingSince: null });
        if (nameChanged) item.matchedAt = null;
        await item.save();
      }
      seenItemIds.add(item.id);
      if (JSON.stringify(t.nfo ?? null) !== JSON.stringify(item.nfo ?? null)) {
        item.nfo = t.nfo ?? null;
        await item.save();
      }

      for (const f of t.files) {
        let row = await MediaFile.findOne({ where: { libraryId: lib.id, root, relPath: f.relPath } });
        const changed = !row || row.size !== f.size || Math.abs(row.mtimeMs - f.mtimeMs) > 1;
        const episodeFields = kind === "series"
          ? { season: f.season ?? null, episode: f.episode ?? null, episodeEnd: f.episodeEnd ?? null, episodeTitle: f.episodeTitle ?? null, nfo: f.nfo ?? null, thumb: f.thumb ?? null }
          : {};
        if (!row) {
          row = await MediaFile.create({ itemId: item.id, libraryId: lib.id, root, relPath: f.relPath, size: f.size, mtimeMs: f.mtimeMs, versionLabel: f.versionLabel, sidecars: f.sidecars, missingSince: null, ...episodeFields });
        } else {
          Object.assign(row, { itemId: item.id, size: f.size, mtimeMs: f.mtimeMs, sidecars: f.sidecars, missingSince: null, ...episodeFields });
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
          if (!tmdbId && t.imdbId) tmdbId = await findTmdbIdByImdb(t.imdbId, kind === "series" ? "tv" : "movie");
          const matched = await enrichLocalTitle({ contentId: localContentId(item.id, kind), type: kind, name: item.name, year: item.year, tmdbId });
          item.matchedTmdbId = matched ?? null;
          item.matchedAt = new Date();
          await item.save();
        } catch (e: any) {
          logger.warn(`[library] could not match "${item.name}": ${e?.message ?? e}`);
        }
      }
      await applyFolderArt(item);
      await applyNfoMeta(item);
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
  const contentId = localContentId(item.id, item.kind);
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
  const kind = item.kind === "series" ? "series" : "movie";
  const matched = await enrichLocalTitle({ contentId: localContentId(item.id, kind), type: kind, name: item.name, year: item.year, tmdbId: tmdbId ?? item.tmdbIdHint });
  item.matchedTmdbId = matched ?? null;
  item.matchedAt = new Date();
  await item.save();
  await applyFolderArt(item);
  await applyNfoMeta(item);
  await recomputeRepresentatives();
  invalidateDiscoverIndex();
  clearDiscoverCache();
  return item;
}
