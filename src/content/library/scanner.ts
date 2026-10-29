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

import { storePeople, peopleCount, titleKeyOf } from "@/content/people";
import { withBusyRetry } from "@/infra/busyRetry";
import { lockOf } from "@/content/customArt";
import { parseNfoFull, type NfoData } from "@/content/library/nfo";
import { findArt, artMarker } from "@/content/library/art";
import fs from "fs";
import path from "path";
import { Op } from "sequelize";
import { Library } from "@/models/Library";
import { LocalItem } from "@/models/LocalItem";
import { MediaFile, SidecarSubtitle } from "@/models/MediaFile";
import { ContentMeta } from "@/models/ContentMeta";
import { ContentGenre } from "@/models/ContentGenre";
import { replaceTags, removeAllTags, tagCount } from "@/content/tags";
import { ContentCountry } from "@/models/ContentCountry";
import { logger } from "@/infra/logger";
import { streamTracker } from "@/services/StreamTracker";
import { enrichLocalTitle, recomputeRepresentatives } from "@/content/metaEnrichment";
import { findTmdbIdByImdb } from "@/content/tmdb";
import { clearDiscoverCache } from "@/services/discoverCache";
import { invalidateDiscoverIndex } from "@/content/discoverIndex";
import { probeFile, resolutionLabel } from "@/content/library/probe";
import { JELLYFIN_ROOT, jellyfinConfig } from "@/content/library/jellyfin";
import { onSettingChange } from "@/config/settings";
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

// Non-blocking file access throughout (speed plan): the libraries are on the NAS, and a
// blocking call while a disk wakes froze every other request for the length of the scan.
async function readDir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statOf(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

/** A Kodi/Jellyfin NFO file, fully parsed (content/library/nfo.ts), or null. */
async function readNfo(p: string): Promise<NfoData | null> {
  try {
    return parseNfoFull((await fs.promises.readFile(p, "utf-8")).slice(0, 512 * 1024));
  } catch {
    return null;
  }
}

/** Jellyfin keeps an episode's thumbnail in metadata/<file>.jpg; Kodi beside it as <file>-thumb.jpg. */
// `here` = file names in the episode's folder, `meta` = file names in its metadata/ folder
// (each folder listed once): no file check per candidate name on the NAS.
function episodeThumb(here: Set<string>, meta: Set<string>, base: string, relDir: string): string | null {
  if (meta.has(base + ".jpg")) return path.join(relDir, "metadata", base + ".jpg");
  if (here.has(base + "-thumb.jpg")) return path.join(relDir, base + "-thumb.jpg");
  if (here.has(base + ".jpg")) return path.join(relDir, base + ".jpg");
  if (meta.has(base + ".png")) return path.join(relDir, "metadata", base + ".png");
  return null;
}

/** Names of the files in a directory listing. */
const fileNames = (entries: fs.Dirent[]) => new Set(entries.filter((e) => e.isFile()).map((e) => e.name));

/** Every title under one library folder. */
async function walk(root: string): Promise<FoundTitle[]> {
  const titles: FoundTitle[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    const entries = await readDir(dir);
    const here = fileNames(entries);
    // Only NFO files the listing shows are opened (no failed open per video on the NAS).
    const nfoIfPresent = (name: string) => (here.has(name) ? readNfo(path.join(dir, name)) : Promise.resolve(null));
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

    const fileOf = async (e: fs.Dirent, label: string | null): Promise<FoundFile | null> => {
      const st = await statOf(path.join(dir, e.name));
      if (!st) return null;
      return { relPath: path.join(relDir, e.name), size: st.size, mtimeMs: st.mtimeMs, versionLabel: label, sidecars: sidecarsFor(e.name) };
    };

    if (videos.length > 0 && depth > 0) {
      // A movie folder: every video whose name starts with the folder's name is a version.
      const asVersions = videos.filter((v) => versionLabelFor(fileBase(v.name), folderBase) !== null || fileBase(v.name).toLowerCase() === folderBase.toLowerCase());
      const nfo = (await nfoIfPresent("movie.nfo")) ?? (videos.length === 1 ? await nfoIfPresent(fileBase(videos[0].name) + ".nfo") : null);
      if (asVersions.length === videos.length || videos.length === 1) {
        const files = (await Promise.all(videos.map((v) => fileOf(v, videos.length === 1 ? null : versionLabelFor(fileBase(v.name), folderBase))))).filter((f): f is FoundFile => !!f);
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
          const f = await fileOf(v, null);
          if (!f) continue;
          const p = parseTitle(fileBase(v.name));
          const own = await nfoIfPresent(fileBase(v.name) + ".nfo");
          titles.push({ relPath: f.relPath, name: own?.title || p.name, year: own?.year || p.year, tmdbId: own?.tmdbId ?? p.tmdbId, imdbId: own?.imdbId ?? p.imdbId, files: [f], nfo: own });
        }
      }
    } else if (videos.length > 0) {
      // Loose files at the top of the library folder: one title each.
      for (const v of videos) {
        const f = await fileOf(v, null);
        if (!f) continue;
        const p = parseTitle(fileBase(v.name));
        const own = await nfoIfPresent(fileBase(v.name) + ".nfo");
        titles.push({ relPath: f.relPath, name: own?.title || p.name, year: own?.year || p.year, tmdbId: own?.tmdbId ?? p.tmdbId, imdbId: own?.imdbId ?? p.imdbId, files: [f], nfo: own });
      }
    }

    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      // Jellyfin's trickplay thumbnails ("<video>.trickplay") and extras folders hold no titles.
      if (!e.isDirectory() || e.name.startsWith(".") || e.name.toLowerCase().endsWith(".trickplay") || EXTRA_DIRS.has(e.name.toLowerCase())) continue;
      await visit(path.join(dir, e.name), depth + 1);
    }
  };
  await visit(root, 0);
  return titles;
}

/** Every show under one series library folder: each top-level folder is a show. */
async function walkSeries(root: string): Promise<FoundTitle[]> {
  const shows: FoundTitle[] = [];
  for (const showDir of await readDir(root)) {
    if (!showDir.isDirectory() || showDir.name.startsWith(".") || EXTRA_DIRS.has(showDir.name.toLowerCase())) continue;
    const showPath = path.join(root, showDir.name);
    const parsed = parseTitle(showDir.name);
    const nfo = await readNfo(path.join(showPath, "tvshow.nfo"));
    const files: FoundFile[] = [];
    const visit = async (dir: string, depth: number, seasonHint: number | null): Promise<void> => {
      const entries = await readDir(dir);
      const here = fileNames(entries);
      const metaDir = entries.find((e) => e.isDirectory() && e.name === "metadata");
      const meta = metaDir ? fileNames(await readDir(path.join(dir, metaDir.name))) : new Set<string>();
      const subs = entries.filter((e) => e.isFile() && SUBTITLE_EXTS.has(path.extname(e.name).toLowerCase()));
      for (const e of entries) {
        if (!e.isFile() || !isVideoFile(e.name) || isExtraFile(e.name) || e.name.startsWith(".")) continue;
        const base = path.basename(e.name, path.extname(e.name));
        const ep = parseEpisode(base, seasonHint);
        if (!ep) continue; // not an episode (no SxxEyy and no season folder): left out
        const st = await statOf(path.join(dir, e.name));
        if (!st) continue;
        const relDir = path.relative(root, dir);
        const epNfo = here.has(base + ".nfo") ? await readNfo(path.join(dir, base + ".nfo")) : null;
        const thumb = episodeThumb(here, meta, base, relDir);
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
          thumb,
        });
      }
      if (depth >= 4) return;
      for (const e of entries) {
        // Jellyfin's metadata/ (episode thumbnails) and trickplay folders hold no episodes.
        if (!e.isDirectory() || e.name.startsWith(".") || e.name.toLowerCase() === "metadata" || e.name.toLowerCase().endsWith(".trickplay")) continue;
        const season = seasonFromFolder(e.name);
        if (season === null && EXTRA_DIRS.has(e.name.toLowerCase())) continue;
        await visit(path.join(dir, e.name), depth + 1, season ?? seasonHint);
      }
    };
    await visit(showPath, 0, null);
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

/**
 * The scan never stops for viewers. A probe reads only a file's headers (a few MB), so
 * while someone streams the scan keeps going with a short gap between probes, leaving
 * the disks to the film in between.
 */
async function paceWhileStreaming(): Promise<void> {
  if (streamTracker.count() > 0) await new Promise((r) => setTimeout(r, 1000));
}

/**
 * Artwork beside a title (Jellyfin's folder.jpg, backdrop.jpg, logo.png) wins over TMDB's:
 * the catalog row's poster/backdrop point at it (content/library/art.ts). Run after every
 * match, since matching writes TMDB's images back.
 */
export async function applyFolderArt(item: LocalItem): Promise<void> {
  let art = item.art ?? null;
  // A Jellyfin title's artwork is Jellyfin's, recorded by the sync (content/library/jellyfinSync.ts).
  if (item.root !== JELLYFIN_ROOT) {
    const dir = path.join(item.root, item.relPath);
    const st = await statOf(dir);
    art = st?.isDirectory() ? await findArt(dir) : null;
    if (JSON.stringify(art ?? null) !== JSON.stringify(item.art ?? null)) {
      item.art = art;
      await item.save();
    }
  }
  if (!art) return;
  const contentId = localContentId(item.id, item.kind);
  const meta = await ContentMeta.findByPk(contentId, { attributes: ["id", "poster", "backdrop", "backdropHd", "artLocked"] });
  if (!meta) return;
  const lock = lockOf(meta); // custom art chosen in the admin page wins over folder art
  const want: Record<string, string> = {};
  if (art.poster && !lock.poster) want.poster = artMarker(item.id, "poster", art.v);
  if (art.backdrop && !lock.backdrop) want.backdrop = want.backdropHd = artMarker(item.id, "backdrop", art.v);
  const changed = Object.entries(want).some(([k, v]) => (meta as any)[k] !== v);
  if (changed) await ContentMeta.update(want, { where: { id: contentId } });
}

/**
 * A title's NFO (Jellyfin's or Kodi's) as a metadata source: it fills whatever TMDB did not
 * give (description, cast, crew, genres, countries, age rating, tagline, runtime, studios,
 * collection, IMDb id), and a locked NFO ("lockdata", your edits in Jellyfin) wins over TMDB.
 * Folder art stays the logo when there is one. Run after every match and art pass.
 */
export async function applyNfoMeta(item: LocalItem): Promise<void> {
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
  if (item.art?.logo && !lockOf(meta).logo) patch.logo = artMarker(item.id, "logo", item.art.v);
  if (Object.keys(patch).length) await ContentMeta.update(patch, { where: { id: contentId } });

  // Cast and crew: from the NFO when TMDB gave none, or when the NFO is locked.
  // A locked NFO keeps its own list (this copy's content id, read first); otherwise the
  // NFO fills the title's shared list only when TMDB gave none (content/people.ts).
  const sharedKey = titleKeyOf({ id: contentId, type: item.kind === "series" ? "series" : "movie", tmdbId: meta?.tmdbId ?? null });
  const peopleKey = locked ? contentId : sharedKey;
  if ((locked || (await peopleCount(sharedKey)) === 0) && (nfo.actors.length || nfo.directors.length)) {
    await storePeople(peopleKey, [
      ...nfo.actors.slice(0, 20).map((a, i) => ({ kind: "cast", name: a.name, role: a.role, order: i, tmdbPersonId: null, photo: null })),
      ...nfo.directors.map((n, i) => ({ kind: "director", name: n, role: null, order: i, tmdbPersonId: null, photo: null })),
      ...nfo.writers.slice(0, 6).map((n, i) => ({ kind: "writer", name: n, role: null, order: i, tmdbPersonId: null, photo: null })),
    ]);
  }
  // Genres and countries: from the NFO when the title has none (or the NFO is locked).
  for (const [Model, values] of [[ContentGenre, nfo.genres], [ContentCountry, nfo.countries]] as const) {
    if (!values.length) continue;
    if (locked || (await tagCount(Model, contentId)) === 0) {
      await replaceTags(Model, contentId, values, { isRepresentative: false });
    }
  }
}

export interface ScanSummary {
  titles: number;
  added: number;
  /** Jellyfin: folder-library titles taken over (their ids, progress and lists kept). */
  adopted?: number;
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

async function scanNow(onlyId?: number): Promise<string> {
  {
    const lines: string[] = [];
    const jellyfin = jellyfinConfig() !== null;
    if (jellyfin && !onlyId) {
      // Jellyfin's movie and show libraries, as libraries here (new ones added).
      const { ensureJellyfinLibraries } = await import("@/content/library/jellyfinSync");
      const note = await ensureJellyfinLibraries();
      if (note) lines.push(note);
    }
    const libs = await Library.findAll({ where: onlyId ? { id: onlyId } : { enabled: true } });
    for (const lib of libs) {
      const fromJellyfin = lib.source === "jellyfin";
      // While Jellyfin is connected it is the source: a folder scan would add the files it
      // took over a second time. The folder library's titles stay as they are.
      const skip = fromJellyfin && !jellyfin ? "not read: Jellyfin is not set up (Settings › Jellyfin)"
        : !fromJellyfin && jellyfin ? "not scanned: Jellyfin is connected, so its libraries are used instead"
        : null;
      if (skip) {
        lines.push(`${lib.name}: ${skip}`);
        continue;
      }
      const s = await scanOne(lib);
      const line =
        `${lib.name}: ${s.titles} titles, ${s.added} new` + (s.adopted ? `, ${s.adopted} taken over from folder libraries` : "") +
        (fromJellyfin ? "" : `, ${s.probed} probed`) + `, ${s.matched} matched, ${s.unmatched} unmatched` +
        (s.missing ? `, ${s.missing} missing` : "") + (s.removed ? `, ${s.removed} removed` : "") +
        (s.skippedFolders.length ? `; skipped (not reachable): ${s.skippedFolders.join(", ")}` : "");
      lib.lastScanAt = new Date();
      lib.lastScanSummary = line;
      await withBusyRetry("[library] saving the scan result", () => lib.save());
      lines.push(line);
      logger.info(`[library] ${line}`);
    }
    if (libs.length) {
      await withBusyRetry("[library] updating Discover", () => recomputeRepresentatives());
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

  if (lib.source === "jellyfin") {
    const { syncJellyfinLibrary } = await import("@/content/library/jellyfinSync");
    const r = await syncJellyfinLibrary(lib, kind, sum);
    for (const id of r.fileIds) seenFileIds.add(id);
    for (const id of r.itemIds) seenItemIds.add(id);
    if (r.complete) scannedRoots.push(JELLYFIN_ROOT);
  }

  for (const root of lib.source === "jellyfin" ? [] : lib.folders || []) {
    const known = await MediaFile.count({ where: { libraryId: lib.id, root } });
    const st = await statOf(root);
    const found = st?.isDirectory() ? (kind === "series" ? await walkSeries(root) : await walk(root)) : [];
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
          await paceWhileStreaming();
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

      await matchAndDecorate(item, t.imdbId, kind, sum);
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

/**
 * Matches a title that is new, renamed, or not matched yet (a later scan retries unmatched
 * ones once a day at most), then applies its artwork and NFO (or Jellyfin) metadata.
 */
export async function matchAndDecorate(item: LocalItem, imdbId: string | null, kind: "movie" | "series", sum: ScanSummary): Promise<void> {
  const retryDue = !item.matchedTmdbId && (!item.matchedAt || Date.now() - item.matchedAt.getTime() > 24 * 3600_000);
  if (!item.matchedAt || retryDue) {
    try {
      let tmdbId = item.tmdbIdLocked ?? item.tmdbIdHint ?? null;
      if (!tmdbId && imdbId) tmdbId = await findTmdbIdByImdb(imdbId, kind === "series" ? "tv" : "movie");
      const matched = await withBusyRetry(`[library] matching "${item.name}"`, () => enrichLocalTitle({ contentId: localContentId(item.id, kind), type: kind, name: item.name, year: item.year, tmdbId }));
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

// Saving the Jellyfin address or key reads its libraries right away (a few seconds after the
// last change, so saving both settings starts one scan).
let jellyfinTimer: NodeJS.Timeout | null = null;
onSettingChange((key) => {
  if (key !== "jellyfinUrl" && key !== "jellyfinApiKey") return;
  if (jellyfinTimer) clearTimeout(jellyfinTimer);
  jellyfinTimer = setTimeout(() => {
    jellyfinTimer = null;
    if (!jellyfinConfig()) return;
    scanLibraries().catch((e) => logger.error(`[library] Jellyfin sync failed: ${e?.message ?? e}`));
  }, 3000);
  jellyfinTimer.unref?.();
});

/** Removes a local title and its catalog row. Watch progress is kept. */
export async function removeItem(item: LocalItem): Promise<void> {
  const contentId = localContentId(item.id, item.kind);
  await MediaFile.destroy({ where: { itemId: item.id } });
  await removeAllTags(contentId);
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
  const matched = await withBusyRetry(`[library] matching "${item.name}"`, () =>
    enrichLocalTitle({ contentId: localContentId(item.id, kind), type: kind, name: item.name, year: item.year, tmdbId: tmdbId ?? item.tmdbIdHint }),
  );
  item.matchedTmdbId = matched ?? null;
  item.matchedAt = new Date();
  await withBusyRetry(`[library] saving "${item.name}"`, () => item.save());
  await applyFolderArt(item);
  await applyNfoMeta(item);
  await withBusyRetry("[library] updating Discover", () => recomputeRepresentatives());
  invalidateDiscoverIndex();
  clearDiscoverCache();
  return item;
}
