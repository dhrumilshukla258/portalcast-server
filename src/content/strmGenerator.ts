import fs from "fs";
import path from "path";
import { Op } from "sequelize";
import { initialConfig } from "@/config/server";
import { xtreamCache } from "@/services/xtreamCache";
import { readGenres } from "@/infra/storage";
import { logger } from "@/infra/logger";
import { StrmMovie } from "@/models/StrmMovie";
import { StrmSeries } from "@/models/StrmSeries";
import { normalizeTitleKey, extractVariantTags } from "@/content/titleClean";

const MOVIES_PATH = process.env.STRM_MOVIES_PATH;
const SERIES_PATH = process.env.STRM_SERIES_PATH;

const normalize = normalizeTitleKey;
const extractTags = extractVariantTags;

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\.+$/, "").trim();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function extractYear(str: string): string {
  const m = String(str || "").match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function strmBase(): string {
  if (process.env.STRM_BASE_URL) return process.env.STRM_BASE_URL.replace(/\/$/, "");
  return `http://localhost:${process.env.PORT || 3000}`;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const UPSERT_FIELDS = ["canonical_key", "raw_folder", "variant_tags", "folder_path", "file_name", "url", "synced_to_disk"];
const CHUNK = 500; // safe SQLite parameter budget (500 rows × 8 cols = 4 000 params)

async function bulkUpsert(Model: typeof StrmMovie | typeof StrmSeries, rows: any[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await Model.bulkCreate(rows.slice(i, i + CHUNK), { updateOnDuplicate: UPSERT_FIELDS });
  }
}

// Best-effort removal of a stale .strm file plus any now-empty parent folders,
// so renames/merges/deletions don't leave orphan files behind on disk.
function removeStaleFile(outputDir: string, folderPath: string, fileName: string): void {
  try {
    const filePath = path.join(outputDir, folderPath, fileName);
    fs.rmSync(filePath, { force: true });

    let dir = path.dirname(filePath);
    const root = path.resolve(outputDir);
    while (path.resolve(dir) !== root && path.resolve(dir).startsWith(root)) {
      const entries = fs.readdirSync(dir);
      if (entries.length > 0) break;
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  } catch {
    // best-effort — ignore missing files/dirs
  }
}

// Writes all unsynced entries concurrently (bounded) instead of one blocking
// mkdirSync+writeFileSync pair per file — avoids stalling the event loop on
// large libraries and skips mkdir syscalls for folders already created this run.
const WRITE_CONCURRENCY = 32;

async function writeEntries(outputDir: string, entries: any[], label: string): Promise<string[]> {
  const madeDirs = new Set<string>();
  const written: string[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      try {
        const dir = path.join(outputDir, entry.folder_path);
        if (!madeDirs.has(dir)) {
          await fs.promises.mkdir(dir, { recursive: true });
          madeDirs.add(dir);
        }
        await fs.promises.writeFile(path.join(dir, entry.file_name), entry.url, "utf8");
        written.push(entry.id);
      } catch (e: any) {
        logger.error(`[STRM] ${label} ${entry.file_name}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, entries.length) }, worker));
  return written;
}

// ── Public entry point ─────────────────────────────────────────────────────────

let isGenerating = false;

export async function generateStrmFiles(): Promise<void> {
  if (!MOVIES_PATH && !SERIES_PATH) return;

  if (isGenerating) {
    logger.warn("[STRM] generation already in progress — skipping this request");
    return;
  }
  isGenerating = true;

  try {
    await generateStrmFilesInner();
  } finally {
    isGenerating = false;
  }
}

async function generateStrmFilesInner(): Promise<void> {
  // XtreamCache is global and readGenres() has no profileId filter, so generation
  // works even when Stalker is the active provider, as long as XtreamCache was
  // populated by a previous Xtream warm. Credentials fall back to ADMIN_EMAIL /
  // ADMIN_PASSWORD, so no extra config is needed for the common case.
  if (initialConfig.providerType !== "xtream") {
    if (!process.env.STRM_XTREAM_USERNAME && !process.env.ADMIN_EMAIL) {
      logger.warn(
        `[STRM] Active provider is "${initialConfig.providerType ?? "stalker"}" and neither STRM_XTREAM_USERNAME ` +
        "nor ADMIN_EMAIL is set. Stream URLs in .strm files will use a placeholder credential. " +
        "Set STRM_XTREAM_USERNAME / STRM_XTREAM_PASSWORD (or ADMIN_EMAIL / ADMIN_PASSWORD) to fix this.",
      );
    }
  }

  if (MOVIES_PATH) await generateMovies(MOVIES_PATH);
  if (SERIES_PATH) await generateSeries(SERIES_PATH);
}

// ── Movies ─────────────────────────────────────────────────────────────────────

async function generateMovies(outputDir: string): Promise<void> {
  logger.info("[STRM] Movies: starting generation...");
  fs.mkdirSync(outputDir, { recursive: true });

  const base = strmBase();
  const u    = process.env.STRM_XTREAM_USERNAME || process.env.ADMIN_EMAIL || "admin";
  const p    = process.env.STRM_XTREAM_PASSWORD || process.env.ADMIN_PASSWORD || "admin";

  // ── Phase 1: bulk upsert raw entries (own folder, no merge yet) ──────────────

  const existingRows = await StrmMovie.findAll({ raw: true }) as any[];
  const existingById = new Map<string, typeof existingRows[0]>(existingRows.map((r) => [r.id, r]));

  const genres = await readGenres("movie");
  const seen   = new Set<string>();
  const toUpsert: any[] = [];
  let cacheIncomplete = false;

  for (const genre of genres) {
    if (!genre.id || genre.id === "*") continue;
    const movies = await xtreamCache.get<any[]>(`vod_streams_${genre.id}`);
    if (!movies) { cacheIncomplete = true; continue; }

    for (const movie of movies) {
      const id = String(movie.stream_id);
      if (seen.has(id)) continue;
      seen.add(id);

      const rawName      = sanitize(movie.name || `Movie_${id}`);
      const year         = extractYear(movie.year || movie.added || "");
      const folderName   = year ? `${rawName} (${year})` : rawName;
      const canonicalKey = normalize(folderName);
      const tags         = extractTags(folderName);
      const ext          = movie.container_extension || "mp4";
      const url          = `${base}/movie/${u}/${p}/${id}.${ext}`;
      const entryId      = `movie_${id}`;
      const existing     = existingById.get(entryId);

      // Re-check canonical_key too, not just url/raw_folder — a titleClean.ts normalization
      // change (new alias, bug fix) must retroactively reflow already-generated entries into
      // their new merge groups, not just apply to newly-discovered content.
      if (!existing || existing.url !== url || existing.raw_folder !== folderName || existing.canonical_key !== canonicalKey) {
        if (existing && existing.raw_folder !== folderName) {
          // title changed upstream — drop the old file, it'll be rewritten under the new name/folder
          removeStaleFile(outputDir, existing.folder_path, existing.file_name);
        }
        toUpsert.push({
          id:             entryId,
          canonical_key:  canonicalKey,
          raw_folder:     folderName,
          variant_tags:   tags.length,
          folder_path:    folderName,
          file_name:      `${folderName}.strm`,
          url,
          synced_to_disk: false,
        });
      }
    }
  }

  if (toUpsert.length > 0) await bulkUpsert(StrmMovie, toUpsert);

  // ── Phase 1b: prune movies no longer present upstream ────────────────────────
  // Skipped when any genre's cache wasn't warmed yet — otherwise we'd delete
  // still-valid content just because it hasn't been fetched into cache.

  if (cacheIncomplete) {
    logger.warn("[STRM] Movies: xtream cache incomplete for one or more genres — skipping prune this run");
  } else {
    const removedMovies = existingRows.filter((r) => !seen.has(r.id.replace(/^movie_/, "")));
    if (removedMovies.length > 0) {
      for (const r of removedMovies) removeStaleFile(outputDir, r.folder_path, r.file_name);
      const removedIds = removedMovies.map((r) => r.id);
      for (let i = 0; i < removedIds.length; i += CHUNK) {
        await StrmMovie.destroy({ where: { id: { [Op.in]: removedIds.slice(i, i + CHUNK) } } });
      }
      logger.info(`[STRM] Movies: pruned ${removedMovies.length} removed entries`);
    }
  }

  // ── Phase 2: merge duplicates in DB ──────────────────────────────────────────

  const allEntries = await StrmMovie.findAll({ raw: true }) as any[];
  const byKey = new Map<string, typeof allEntries>();
  for (const e of allEntries) {
    const group = byKey.get(e.canonical_key) ?? [];
    group.push(e);
    byKey.set(e.canonical_key, group);
  }

  const mergeUpdates: any[] = [];
  for (const [, group] of byKey) {
    if (group.length <= 1) continue;

    group.sort((a: any, b: any) =>
      a.variant_tags - b.variant_tags || a.raw_folder.localeCompare(b.raw_folder)
    );
    const primary     = group[0];
    const secondaries = group.slice(1);

    for (const sec of secondaries) {
      const tags       = extractTags(sec.raw_folder);
      const label      = tags.length > 0 ? tags.join(" ") : sec.raw_folder;
      const mergedFile = `${sec.raw_folder} [${label}].strm`;

      if (sec.folder_path !== primary.folder_path || sec.file_name !== mergedFile) {
        if (sec.synced_to_disk) removeStaleFile(outputDir, sec.folder_path, sec.file_name);
        mergeUpdates.push({
          id:             sec.id,
          canonical_key:  sec.canonical_key,
          raw_folder:     sec.raw_folder,
          variant_tags:   sec.variant_tags,
          folder_path:    primary.folder_path,
          file_name:      mergedFile,
          url:            sec.url,
          synced_to_disk: false,
        });
      }
    }
  }
  if (mergeUpdates.length > 0) await bulkUpsert(StrmMovie, mergeUpdates);

  // ── Phase 3: write unsynced entries to disk ───────────────────────────────────

  const toWrite = await StrmMovie.findAll({ where: { synced_to_disk: false }, raw: true }) as any[];

  if (toWrite.length === 0) {
    logger.info("[STRM] Movies: nothing to write");
    return;
  }

  const written = await writeEntries(outputDir, toWrite, "movie");

  for (let i = 0; i < written.length; i += CHUNK) {
    await StrmMovie.update({ synced_to_disk: true }, { where: { id: { [Op.in]: written.slice(i, i + CHUNK) } } });
  }

  logger.info(`[STRM] Movies done — ${written.length} files written`);
}

// ── Series ─────────────────────────────────────────────────────────────────────

async function generateSeries(outputDir: string): Promise<void> {
  logger.info("[STRM] Series: starting generation...");
  fs.mkdirSync(outputDir, { recursive: true });

  const base = strmBase();
  const u    = process.env.STRM_XTREAM_USERNAME || process.env.ADMIN_EMAIL || "admin";
  const p    = process.env.STRM_XTREAM_PASSWORD || process.env.ADMIN_PASSWORD || "admin";

  // ── Phase 1: bulk upsert raw entries ─────────────────────────────────────────

  const existingRows = await StrmSeries.findAll({ raw: true }) as any[];
  const existingById = new Map<string, typeof existingRows[0]>(existingRows.map((r) => [r.id, r]));

  const genres    = await readGenres("series");
  const seenShows = new Set<number>();
  const seenEpisodes = new Set<string>();
  const toUpsert: any[] = [];
  let cacheIncomplete = false;

  for (const genre of genres) {
    if (!genre.id || genre.id === "*") continue;
    const seriesList = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
    if (!seriesList) { cacheIncomplete = true; continue; }

    const uniqueSeries = seriesList.filter((s) => s.series_id && !seenShows.has(s.series_id as number));
    for (const s of uniqueSeries) seenShows.add(s.series_id as number);
    const infoByKey = await xtreamCache.getMany<any>(uniqueSeries.map((s) => `series_info_${s.series_id}`));

    for (const series of uniqueSeries) {
      const seriesId = series.series_id as number;

      try {
        const seriesInfo = infoByKey.get(`series_info_${seriesId}`);
        if (!seriesInfo?.episodes) { cacheIncomplete = true; continue; }

        const rawName  = sanitize(series.name || `Series_${seriesId}`);
        const year     = extractYear(series.releaseDate || "");
        const showName = year ? `${rawName} (${year})` : rawName;
        const canonicalKey = normalize(showName);
        const variantTags  = extractTags(showName).length;

        for (const [seasonNum, episodes] of Object.entries(seriesInfo.episodes)) {
          const seasonFolder = `Season ${pad(parseInt(seasonNum))}`;
          const folderPath   = `${showName}/${seasonFolder}`;

          for (const ep of episodes as any[]) {
            const epId     = String(ep.id);
            const entryId  = `seriesep_${epId}`;
            const existing = existingById.get(entryId);
            seenEpisodes.add(entryId);

            const epNum    = pad(parseInt(String(ep.episode_num || 1)));
            const s        = pad(parseInt(seasonNum));
            const epTitle  = sanitize(ep.title || `Episode ${ep.episode_num}`).slice(0, 80);
            const fileName = `${showName} S${s}E${epNum} - ${epTitle}.strm`;
            const ext      = ep.container_extension || "mp4";
            const url      = `${base}/series/${u}/${p}/${epId}.${ext}`;

            // Re-check canonical_key too, not just url/raw_folder — see the movies-phase
            // comment above: normalization changes must reflow already-generated entries.
            if (!existing || existing.url !== url || existing.raw_folder !== showName || existing.canonical_key !== canonicalKey) {
              if (existing && existing.raw_folder !== showName) {
                // show renamed upstream — drop the old file, it'll be rewritten under the new name
                removeStaleFile(outputDir, existing.folder_path, existing.file_name);
              }
              toUpsert.push({
                id:             entryId,
                canonical_key:  canonicalKey,
                raw_folder:     showName,
                variant_tags:   variantTags,
                folder_path:    folderPath,
                file_name:      fileName,
                url,
                synced_to_disk: false,
              });
            }
          }
        }
      } catch (e: any) {
        logger.error(`[STRM] series ${series.name}: ${e.message}`);
      }
    }
  }

  if (toUpsert.length > 0) await bulkUpsert(StrmSeries, toUpsert);

  // ── Phase 2: merge duplicate shows in DB ─────────────────────────────────────

  const allEntries = await StrmSeries.findAll({ raw: true }) as any[];

  const showGroups = new Map<string, Set<string>>();
  for (const e of allEntries) {
    const group = showGroups.get(e.canonical_key) ?? new Set();
    group.add(e.raw_folder);
    showGroups.set(e.canonical_key, group);
  }

  const primaryShowByKey = new Map<string, string>();
  for (const [key, shows] of showGroups) {
    if (shows.size <= 1) continue;
    const sorted = [...shows].sort((a, b) => {
      const ta = extractTags(a).length;
      const tb = extractTags(b).length;
      return ta - tb || a.localeCompare(b);
    });
    primaryShowByKey.set(key, sorted[0]);
  }

  const mergeUpdates: any[] = [];
  for (const e of allEntries) {
    const primaryShow = primaryShowByKey.get(e.canonical_key);
    if (!primaryShow || e.raw_folder === primaryShow) continue;

    const seasonPart   = e.folder_path.split("/").slice(1).join("/");
    const mergedFolder = `${primaryShow}/${seasonPart}`;
    const mergedFile   = e.file_name.replace(e.raw_folder, primaryShow);

    if (e.folder_path !== mergedFolder || e.file_name !== mergedFile) {
      if (e.synced_to_disk) removeStaleFile(outputDir, e.folder_path, e.file_name);
      mergeUpdates.push({
        id:             e.id,
        canonical_key:  e.canonical_key,
        raw_folder:     e.raw_folder,
        variant_tags:   e.variant_tags,
        folder_path:    mergedFolder,
        file_name:      mergedFile,
        url:            e.url,
        synced_to_disk: false,
      });
    }
  }
  if (mergeUpdates.length > 0) await bulkUpsert(StrmSeries, mergeUpdates);

  // ── Phase 2b: prune episodes/shows no longer present upstream ───────────────
  // Skipped when any series' cache wasn't fully warmed — otherwise we'd delete
  // still-valid episodes just because their info hasn't been fetched into cache.

  if (cacheIncomplete) {
    logger.warn("[STRM] Series: xtream cache incomplete for one or more genres/shows — skipping prune this run");
  } else {
    const removedEpisodes = existingRows.filter((r) => !seenEpisodes.has(r.id));
    if (removedEpisodes.length > 0) {
      for (const r of removedEpisodes) removeStaleFile(outputDir, r.folder_path, r.file_name);
      const removedIds = removedEpisodes.map((r) => r.id);
      for (let i = 0; i < removedIds.length; i += CHUNK) {
        await StrmSeries.destroy({ where: { id: { [Op.in]: removedIds.slice(i, i + CHUNK) } } });
      }
      logger.info(`[STRM] Series: pruned ${removedEpisodes.length} removed episodes`);
    }
  }

  // ── Phase 3: write unsynced entries to disk ───────────────────────────────────

  const toWrite = await StrmSeries.findAll({ where: { synced_to_disk: false }, raw: true }) as any[];

  if (toWrite.length === 0) {
    logger.info("[STRM] Series: nothing to write");
    return;
  }

  const written = await writeEntries(outputDir, toWrite, "episode");

  for (let i = 0; i < written.length; i += CHUNK) {
    await StrmSeries.update({ synced_to_disk: true }, { where: { id: { [Op.in]: written.slice(i, i + CHUNK) } } });
  }

  logger.info(`[STRM] Series done — ${written.length} files written`);
}
