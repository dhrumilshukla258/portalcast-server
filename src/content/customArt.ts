// Custom artwork chosen in the admin page ("Edit images" on a detail page): a TMDB alternative
// or an upload, per kind (poster, backdrop, logo). Stored in <custom images folder>/<id>/,
// applied to every version of the title (its group), and locked: TMDB refreshes, folder art
// and NFO files never replace it (content_meta.artLocked). "Reset" removes the lock and
// brings the automatic image back.
//
// Served like local-library art: the marker "local-art:c<contentId>:<kind>:<version>" turns
// into a signed /api/images/local URL (content/library/art.ts, routes/library/stream.ts).

import fs from "fs";
import path from "path";
import axios from "axios";
import { Op, QueryTypes } from "sequelize";
import { ContentMeta } from "@/models/ContentMeta";
import { dataDir } from "@/infra/paths";
import { setting } from "@/config/settings";
import { artMarker } from "@/content/library/art";
import { sniffRasterImage } from "@/infra/sniffImage";
import { fetchMetaByTmdbId } from "@/content/tmdb";
import { clearDiscoverCache } from "@/services/discoverCache";

export type CustomKind = "poster" | "backdrop" | "logo";
export interface ArtLock { poster?: string; backdrop?: string; logo?: string; v?: number }

/** Setting customArtFolder (a NAS folder mounted into the container), else <data>/custom-art. */
export function customArtFolder(): string {
  const configured = String(setting<string>("customArtFolder") || "").trim();
  return configured ? path.resolve(configured) : path.join(dataDir, "custom-art");
}

export function customFile(contentId: string, name: string): string {
  return path.join(customArtFolder(), contentId.replace(/[^\w-]/g, ""), name);
}

/** The lock of a row, whatever shape the JSON column came back in. */
export function lockOf(row: { artLocked?: any } | null | undefined): ArtLock {
  let v = row?.artLocked;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { v = null; }
  }
  return v && typeof v === "object" ? v : {};
}

async function groupIds(contentId: string): Promise<string[]> {
  const row = await ContentMeta.findByPk(contentId, { attributes: ["id", "groupKey"] });
  if (!row) return [];
  if (!row.groupKey) return [row.id];
  return ((await ContentMeta.findAll({ where: { groupKey: row.groupKey }, attributes: ["id"], raw: true })) as any[]).map((r) => r.id);
}

/** Saves image bytes as the title's custom `kind` and points every version at it. */
export async function setCustomArt(contentId: string, kind: CustomKind, bytes: Buffer): Promise<void> {
  const type = sniffRasterImage(bytes);
  if (!type) throw new Error("Only PNG, JPEG, GIF, WebP or AVIF images are allowed");
  const name = `${kind}.${type}`;
  const file = customFile(contentId, name);
  // Non-blocking: the folder can be on the NAS.
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  for (const old of await fs.promises.readdir(path.dirname(file))) if (old.startsWith(`${kind}.`) && old !== name) await fs.promises.rm(path.join(path.dirname(file), old), { force: true });
  await fs.promises.writeFile(`${file}.part`, bytes);
  await fs.promises.rename(`${file}.part`, file);

  const v = Math.floor(Date.now() / 1000);
  const marker = artMarker(`c${contentId}`, kind, v);
  const owner = await ContentMeta.findByPk(contentId);
  if (!owner) throw new Error("Unknown title");
  const lock: ArtLock = { ...lockOf(owner), [kind]: name, v };
  for (const id of await groupIds(contentId)) {
    const row = await ContentMeta.findByPk(id, { attributes: ["id", "artLocked"] });
    const patch: Record<string, any> = { artLocked: { ...lockOf(row), ...(id === contentId ? lock : { [kind]: `@${contentId}`, v }) } };
    if (kind === "poster") patch.poster = marker;
    if (kind === "backdrop") patch.backdrop = patch.backdropHd = marker;
    if (kind === "logo") patch.logo = marker;
    await ContentMeta.update(patch, { where: { id } });
  }
  clearDiscoverCache();
}

/** A TMDB image path ("/abc.jpg") chosen from the alternatives, as the custom `kind`. */
export async function setCustomArtFromTmdb(contentId: string, kind: CustomKind, tmdbPath: string): Promise<void> {
  if (!/^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(tmdbPath)) throw new Error("Not a TMDB image path");
  const size = kind === "poster" ? "w780" : "original";
  const res = await axios.get(`https://image.tmdb.org/t/p/${size}${tmdbPath}`, { responseType: "arraybuffer", timeout: 20000, maxContentLength: 25 * 1024 * 1024 });
  await setCustomArt(contentId, kind, Buffer.from(res.data));
}

/** Removes the custom `kind` from every version and brings back TMDB's image. */
export async function resetCustomArt(contentId: string, kind: CustomKind): Promise<void> {
  // Its group now, plus any row still pointing at it (groups can change after a choice).
  const ids = await groupIds(contentId);
  const pointing = (await ContentMeta.sequelize!.query("SELECT `id` FROM `content_meta` WHERE `artLocked` LIKE ?", {
    replacements: [`%"@${contentId}"%`],
    type: QueryTypes.SELECT,
  })) as any[];
  const rows = await ContentMeta.findAll({ where: { id: { [Op.in]: [...new Set([...ids, ...pointing.map((p) => p.id)])] } } });
  for (const row of rows) {
    const lock = lockOf(row);
    if (!lock[kind]) continue;
    delete lock[kind];
    const patch: Record<string, any> = { artLocked: Object.keys(lock).some((k) => k !== "v") ? lock : null };
    // TMDB's image back when the title is matched; otherwise empty, and folder art (local
    // titles) or the next match fills it.
    const meta = row.tmdbId ? await fetchMetaByTmdbId(row.type === "series" ? "tv" : "movie", Number(row.tmdbId)).catch(() => null) : null;
    if (kind === "poster") patch.poster = meta?.poster ?? null;
    if (kind === "backdrop") { patch.backdrop = meta?.backdrop ?? null; patch.backdropHd = meta?.backdropHd ?? null; }
    if (kind === "logo") patch.logo = meta?.details?.logo ?? null;
    await ContentMeta.update(patch, { where: { id: row.id } });
  }
  const dir = path.dirname(customFile(contentId, "x"));
  for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    if (f.startsWith(`${kind}.`)) await fs.promises.rm(customFile(contentId, f), { force: true });
  }
  clearDiscoverCache();
}

/** The file a "c<contentId>" art marker of `kind` names (following a group member's lock). */
export async function customArtPath(contentId: string, kind: string): Promise<string | null> {
  const row = await ContentMeta.findByPk(contentId, { attributes: ["id", "artLocked"] });
  const entry = (lockOf(row) as any)[kind];
  if (!entry) return null;
  if (String(entry).startsWith("@")) return customArtPath(String(entry).slice(1), kind);
  const file = customFile(contentId, String(entry));
  return (await fs.promises.access(file).then(() => true, () => false)) ? file : null;
}
