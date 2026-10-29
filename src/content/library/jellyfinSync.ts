// Reads the connected Jellyfin server's libraries into the local library's tables
// (content/library/jellyfin.ts). Called by the scan (content/library/scanner.ts) for a
// library whose source is "jellyfin": Admin › Libraries › Scan, the nightly scan, and a few
// seconds after the Jellyfin settings are saved.
//
// A Jellyfin file keeps its ids across syncs: it is found by its Jellyfin ids, else by its
// path as Jellyfin sees it (Jellyfin re-created the item), else it TAKES OVER the matching
// file of a folder library — the path Jellyfin reports ends with that file's path below its
// library folder ("/data/movies/Heat (1995)/Heat.mkv" takes over "Heat (1995)/Heat.mkv"
// scanned under /media/movies). Taking over keeps the title's and the file's ids, so watch
// progress, My List and Continue Watching stay as they were (owner 2026-10-28: the folder
// scanner goes, Jellyfin replaces it).
//
// Jellyfin unreachable, or a library that comes back empty while it had titles: nothing is
// marked missing (as an unplugged disk is for folders).

import { Op } from "sequelize";
import { Library } from "@/models/Library";
import { LocalItem } from "@/models/LocalItem";
import { MediaFile } from "@/models/MediaFile";
import { logger } from "@/infra/logger";
import { resolutionLabel } from "@/content/library/probe";
import { matchAndDecorate, type ScanSummary } from "@/content/library/scanner";
import {
  JELLYFIN_ROOT, jellyfinLibraries, jellyfinItems, isJellyfinId, nfoOf, artOf, fileFieldsOf, versionLabelOf,
  normalizedPath, tagVersion, type JfItem, type JfSource,
} from "@/content/library/jellyfin";

/** Jellyfin's movie and show libraries as Library rows: new ones added, renamed ones renamed. */
export async function ensureJellyfinLibraries(): Promise<string | null> {
  let remote;
  try {
    remote = await jellyfinLibraries();
  } catch (e: any) {
    logger.warn(`[jellyfin] could not read the libraries: ${e?.message ?? e}`);
    return `Jellyfin: not reachable (${e?.message ?? e}); nothing changed`;
  }
  const mine = await Library.findAll({ where: { source: "jellyfin" } });
  const byRemoteId = new Map(mine.map((l) => [String((l.folders ?? [])[0]), l]));
  for (const r of remote) {
    const lib = byRemoteId.get(r.id);
    if (!lib) {
      await Library.create({ name: r.name, kind: r.kind, folders: [r.id], source: "jellyfin", enabled: true });
      logger.info(`[jellyfin] library "${r.name}" (${r.kind}) added`);
    } else if (lib.name !== r.name || lib.kind !== r.kind) {
      Object.assign(lib, { name: r.name, kind: r.kind });
      await lib.save();
    }
  }
  // A library removed in Jellyfin is switched off here; its titles stay until an admin deletes it.
  const gone = mine.filter((l) => l.enabled && !remote.some((r) => r.id === String((l.folders ?? [])[0])));
  for (const l of gone) {
    l.enabled = false;
    l.lastScanSummary = "Switched off: this library is no longer on the Jellyfin server";
    await l.save();
  }
  return null;
}

interface Plan { src: JfSource; rel: string; remote: string; row: MediaFile | null; episode?: JfItem; sources: number }

/** Folder-library files of one kind, by file name, for taking over (see the top of the file). */
async function takeoverIndex(kind: "movie" | "series"): Promise<Map<string, MediaFile[]>> {
  const folderLibs = await Library.findAll({ where: { [Op.or]: [{ source: null }, { source: { [Op.ne]: "jellyfin" } }], kind: kind === "series" ? "series" : "movies" }, attributes: ["id"] });
  const index = new Map<string, MediaFile[]>();
  if (!folderLibs.length) return index;
  const rows = await MediaFile.findAll({ where: { libraryId: { [Op.in]: folderLibs.map((l) => l.id) }, root: { [Op.ne]: JELLYFIN_ROOT } } });
  for (const r of rows) {
    const rel = normalizedPath(r.relPath).replace(/^\/+/, "");
    const base = rel.split("/").pop()!.toLowerCase();
    index.set(base, [...(index.get(base) ?? []), r]);
  }
  return index;
}

export async function syncJellyfinLibrary(lib: Library, kind: "movie" | "series", sum: ScanSummary): Promise<{ fileIds: number[]; itemIds: number[]; complete: boolean }> {
  const fileIds: number[] = [];
  const itemIds: number[] = [];
  const parentId = String((lib.folders ?? [])[0] ?? "");
  if (!isJellyfinId(parentId)) {
    sum.skippedFolders.push("Jellyfin (this library has no Jellyfin id)");
    return { fileIds, itemIds, complete: false };
  }

  let titles: JfItem[];
  let episodes: JfItem[] = [];
  try {
    titles = await jellyfinItems(parentId, kind === "series" ? "Series" : "Movie");
    if (kind === "series") episodes = await jellyfinItems(parentId, "Episode");
  } catch (e: any) {
    logger.warn(`[jellyfin] ${lib.name}: ${e?.message ?? e}`);
    sum.skippedFolders.push(`Jellyfin (${e?.message ?? e})`);
    return { fileIds, itemIds, complete: false };
  }
  logger.info(`[jellyfin] ${lib.name}: ${titles.length} ${kind === "series" ? `shows, ${episodes.length} episodes` : "movies"}`);

  const known = await LocalItem.count({ where: { libraryId: lib.id, root: JELLYFIN_ROOT } });
  if (titles.length === 0 && known > 0) {
    sum.skippedFolders.push("Jellyfin (the library came back empty)");
    return { fileIds, itemIds, complete: false };
  }

  const rows = await MediaFile.findAll({ where: { libraryId: lib.id, root: JELLYFIN_ROOT } });
  const rowByRel = new Map(rows.map((r) => [r.relPath, r]));
  const rowByRemote = new Map(rows.filter((r) => r.remotePath).map((r) => [r.remotePath!, r]));
  const items = await LocalItem.findAll({ where: { libraryId: lib.id, root: JELLYFIN_ROOT } });
  const itemByRel = new Map(items.map((i) => [i.relPath, i]));
  const takeover = await takeoverIndex(kind);
  const claimedRows = new Set<number>();
  const claimedItems = new Set<number>();
  const heirs = new Set<number>();
  const now = new Date();

  // The folder-library file whose path below its library folder ends Jellyfin's path (longest wins).
  const takeOver = (remote: string): MediaFile | null => {
    const base = remote.split("/").pop()!.toLowerCase();
    let best: MediaFile | null = null;
    for (const r of takeover.get(base) ?? []) {
      if (claimedRows.has(r.id)) continue;
      const rel = normalizedPath(r.relPath).replace(/^\/+/, "");
      if (!remote.endsWith("/" + rel) && remote !== rel) continue;
      if (!best || rel.length > normalizedPath(best.relPath).length) best = r;
    }
    return best;
  };

  const planFor = (owner: JfItem, src: JfSource, sources: number, episode?: JfItem): Plan => {
    const rel = `${owner.Id}/${src.Id}`;
    const remote = normalizedPath(src.Path);
    let row = rowByRel.get(rel) ?? (remote ? rowByRemote.get(remote) : undefined) ?? null;
    if (row && claimedRows.has(row.id)) row = null;
    if (!row && remote) row = takeOver(remote);
    if (row) claimedRows.add(row.id);
    return { src, rel, remote, row, episode, sources };
  };

  const playable = (it: JfItem) => (it.MediaSources ?? []).filter((s) => isJellyfinId(s.Id) && it.LocationType !== "Virtual");

  // Series: the episodes of each show.
  const episodesBySeries = new Map<string, JfItem[]>();
  for (const ep of episodes) {
    if (!ep.SeriesId || ep.IndexNumber == null) continue; // no episode number: left out, as the folder scan does
    episodesBySeries.set(ep.SeriesId, [...(episodesBySeries.get(ep.SeriesId) ?? []), ep]);
  }

  for (const it of titles) {
    const plans: Plan[] = kind === "series"
      ? (episodesBySeries.get(it.Id) ?? []).flatMap((ep) => playable(ep).map((s, _i, all) => planFor(ep, s, all.length, ep)))
      : playable(it).map((s, _i, all) => planFor(it, s, all.length));
    if (!plans.length) continue;
    sum.titles++;
    if (sum.titles % 100 === 0) logger.info(`[jellyfin] ${lib.name}: ${sum.titles}/${titles.length} done`);

    // The title: its own row, else the title of a file it took over (keeps the title's id).
    let item = itemByRel.get(it.Id) ?? null;
    if (item && claimedItems.has(item.id)) item = null;
    if (!item) {
      const heirId = plans.map((p) => p.row?.itemId).find((id) => id != null && !claimedItems.has(id));
      const heir = heirId != null ? await LocalItem.findByPk(heirId) : null;
      if (heir) {
        // From a folder library, or a Jellyfin item Jellyfin re-created (same file, new id).
        if (heir.root !== JELLYFIN_ROOT) sum.adopted = (sum.adopted ?? 0) + 1;
        Object.assign(heir, { libraryId: lib.id, root: JELLYFIN_ROOT, relPath: it.Id, matchedAt: heir.matchedTmdbId ? heir.matchedAt : null });
        item = heir;
        heirs.add(heir.id);
      } else {
        item = await LocalItem.create({ libraryId: lib.id, kind, root: JELLYFIN_ROOT, relPath: it.Id, name: it.Name, year: null, missingSince: null });
        sum.added++;
      }
    }
    claimedItems.add(item.id);
    itemIds.push(item.id);

    const nfo = nfoOf(it);
    const year = it.ProductionYear ? String(it.ProductionYear) : null;
    const renamed = item.name !== it.Name || (item.year ?? null) !== year || (item.tmdbIdHint ?? null) !== (nfo.tmdbId ?? null);
    Object.assign(item, { kind, name: it.Name, year, tmdbIdHint: nfo.tmdbId, nfo, art: artOf(it), missingSince: null });
    if (renamed) item.matchedAt = null;
    await item.save();

    for (const p of plans) {
      const f = fileFieldsOf(p.src);
      const ep = p.episode;
      const still = ep?.ImageTags?.Primary;
      const fields: Record<string, any> = {
        itemId: item.id, libraryId: lib.id, root: JELLYFIN_ROOT, relPath: p.rel, remotePath: p.remote || null,
        ...f,
        versionLabel: versionLabelOf(p.src, p.sources) ?? resolutionLabel(f.width, f.height),
        // An episode still's version (artwork URLs carry it); nothing else reads it for Jellyfin files.
        mtimeMs: still ? (tagVersion(still) % 2_000_000) * 1000 : 0,
        probedAt: now, probeError: null, keyframes: null, missingSince: null,
        season: ep ? ep.ParentIndexNumber ?? 1 : null,
        episode: ep ? ep.IndexNumber ?? null : null,
        episodeEnd: ep?.IndexNumberEnd ?? null,
        episodeTitle: ep?.Name || null,
        nfo: ep ? {
          title: ep.Name || null, plot: ep.Overview || null,
          rating: typeof ep.CommunityRating === "number" ? Math.round(ep.CommunityRating * 10) / 10 : null,
          premiered: ep.PremiereDate ? ep.PremiereDate.slice(0, 10) : null,
          runtime: ep.RunTimeTicks ? Math.round(ep.RunTimeTicks / 6e8) : null,
          directors: (ep.People ?? []).filter((x) => x.Type === "Director").map((x) => x.Name),
        } : null,
        thumb: still ? "jellyfin" : null,
        sidecars: f.sidecars,
      };
      let row = p.row;
      if (row) {
        Object.assign(row, fields);
        await row.save();
      } else {
        row = await MediaFile.create(fields);
      }
      fileIds.push(row.id);
    }

    await matchAndDecorate(item, nfo.imdbId, kind, sum);
  }

  // A taken-over title's other folder files that Jellyfin does not have: hidden (not deleted).
  if (heirs.size) {
    await MediaFile.update({ missingSince: now }, { where: { itemId: { [Op.in]: [...heirs] }, root: { [Op.ne]: JELLYFIN_ROOT }, missingSince: null } });
  }
  return { fileIds, itemIds, complete: true };
}
