// One title, one position: progress saved on any version of a title (an IPTV copy, another
// language, the NAS file) resumes on every other version. Done when progress is read, not
// stored: GET /api/user/progress adds "mirror" rows so each version's id carries the newest
// position of its group (content_meta groupKey). Nothing is written, so removing the real
// row removes its mirrors too.
//
// Mirrors keep the original's meta (meta.id/itemId unchanged): both apps collapse Continue
// Watching by those ids, so a title still shows once. Movies mirror fully; a series mirrors
// its series-level row (its Continue entry); episode positions stay per version, because
// episode ids differ between versions.

import { Op } from "sequelize";
import { ContentMeta } from "@/models/ContentMeta";
import { LocalItem } from "@/models/LocalItem";
import { MediaFile } from "@/models/MediaFile";

type Row = { mediaId: string; progress: number; completed: boolean; meta: any; [k: string]: any };

function contentIdOf(row: Row): string | null {
  const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
  const type = meta.type === "series" || meta.is_series == 1 ? "series" : meta.type === "movie" || !meta.type ? "movie" : null;
  if (!type) return null;
  // Only a series' own row (keyed by the series id) is mirrored; its episode rows are not.
  if (type === "series" && String(row.mediaId) !== String(meta.mediaId ?? row.mediaId)) return null;
  if (typeof meta.catalogId === "string" && meta.catalogId.startsWith(`${type}_`)) return meta.catalogId;
  return `${type}_${row.mediaId}`;
}

const stamp = (r: Row) => Number(r.meta?.timestamp) || 0;

export async function withProgressMirrors(rows: Row[]): Promise<Row[]> {
  const byContent = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.meta?.type === "tv") continue;
    const cid = contentIdOf(r);
    if (!cid) continue;
    byContent.set(cid, [...(byContent.get(cid) ?? []), r]);
  }
  if (byContent.size === 0) return rows;

  const own = (await ContentMeta.findAll({ where: { id: { [Op.in]: [...byContent.keys()] } }, attributes: ["id", "groupKey"], raw: true })) as any[];
  const keys = [...new Set(own.map((o) => o.groupKey).filter(Boolean))];
  if (keys.length === 0) return rows;
  const members = (await ContentMeta.findAll({ where: { groupKey: { [Op.in]: keys } }, attributes: ["id", "groupKey"], raw: true })) as any[];
  const membersByGroup = new Map<string, string[]>();
  for (const m of members) membersByGroup.set(m.groupKey, [...(membersByGroup.get(m.groupKey) ?? []), m.id]);

  // Local movies also resume by their file ids (the webui keys a movie's position by file).
  const localItemIds = members.map((m) => /^movie_L(\d+)$/.exec(m.id)?.[1]).filter(Boolean).map(Number);
  const filesByItem = new Map<number, string[]>();
  if (localItemIds.length) {
    const present = new Set((await LocalItem.findAll({ where: { id: { [Op.in]: localItemIds } }, attributes: ["id"], raw: true }) as any[]).map((i) => i.id));
    for (const f of (await MediaFile.findAll({ where: { itemId: { [Op.in]: [...present] }, missingSince: null }, attributes: ["id", "itemId"], raw: true })) as any[]) {
      filesByItem.set(f.itemId, [...(filesByItem.get(f.itemId) ?? []), `LF${f.id}`]);
    }
  }

  const realById = new Map(rows.map((r) => [String(r.mediaId), r]));
  const mirrors = new Map<string, Row>();
  for (const o of own) {
    if (!o.groupKey) continue;
    const group = membersByGroup.get(o.groupKey) ?? [];
    if (group.length < 2) continue;
    // The newest row anywhere in the group is the position every version should resume at.
    const groupRows = group.flatMap((cid) => byContent.get(cid) ?? []);
    const newest = groupRows.sort((a, b) => stamp(b) - stamp(a))[0];
    if (!newest) continue;
    for (const cid of group) {
      const raw = cid.replace(/^(movie|series)_/, "");
      const ids = [raw, ...(cid.startsWith("movie_L") ? filesByItem.get(Number(raw.slice(1))) ?? [] : [])];
      for (const id of ids) {
        const real = realById.get(id);
        if (real && stamp(real) >= stamp(newest)) continue; // its own position is the newest
        const prev = mirrors.get(id);
        if (prev && stamp(prev) >= stamp(newest)) continue;
        mirrors.set(id, { ...newest, mediaId: id, meta: { ...(newest.meta ?? {}), mirrorOf: newest.mediaId } });
      }
    }
  }
  if (mirrors.size === 0) return rows;
  // A mirror replaces an older real row for the same id.
  return [...rows.filter((r) => !mirrors.has(String(r.mediaId))), ...mirrors.values()];
}
