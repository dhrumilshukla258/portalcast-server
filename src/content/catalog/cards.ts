// Title rows for cards (Discover browse and rows; plan, Phase 1b): the content_meta columns
// and genre/country tags of a page of titles, from the snapshot instead of three SQLite
// queries per page. A title written since the snapshot was built (its row or its tags, per the
// change log, read on every call) or not in it yet is read from the database as before.

import { Op } from "sequelize";
import { setting } from "@/config/settings";
import { ContentMeta } from "@/models/ContentMeta";
import { ContentGenre } from "@/models/ContentGenre";
import { ContentCountry } from "@/models/ContentCountry";
import { catalogReady, catalogChanges, COPY_COLUMNS } from "./store";

export interface TitleRows {
  /** content id -> row (the snapshot's columns, as stored; a Sequelize row for database reads). */
  rows: Map<string, any>;
  genres: Map<string, string[]>;
  countries: Map<string, string[]>;
}

/** Tags of these titles, from the database, in stored order (the routes' tagsByContentId). */
async function tagsFromDb(Model: typeof ContentGenre | typeof ContentCountry, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const rows = (await Model.findAll({ where: { contentId: { [Op.in]: ids } }, raw: true })) as any[];
  for (const r of rows) {
    const list = map.get(r.contentId) ?? [];
    list.push(r.value);
    map.set(r.contentId, list);
  }
  return map;
}

/** Rows and tags for `ids` from the database only (the snapshot off, or titles changed since). */
export async function titleRowsFromDb(ids: string[]): Promise<TitleRows> {
  const found = ids.length ? await ContentMeta.findAll({ where: { id: { [Op.in]: ids } } }) : [];
  const [genres, countries] = await Promise.all([tagsFromDb(ContentGenre, ids), tagsFromDb(ContentCountry, ids)]);
  return { rows: new Map(found.map((r: any) => [r.id as string, r])), genres, countries };
}

/** Rows and tags for `ids`: the snapshot for titles unchanged since it was built. */
export async function titleRows(ids: string[]): Promise<TitleRows> {
  const snap = setting<boolean>("catalogSnapshot") ? await catalogReady() : null;
  const changes = snap ? await catalogChanges() : null;
  if (!snap || !changes || changes.snap !== snap) return titleRowsFromDb(ids);
  const out: TitleRows = { rows: new Map(), genres: new Map(), countries: new Map() };
  const fromDb: string[] = [];
  for (const id of new Set(ids)) {
    const i = snap.copyIndex(id);
    if (i < 0 || changes.has("title", id) || changes.has("tags", id)) { fromDb.push(id); continue; }
    const row: Record<string, any> = {};
    for (const c of COPY_COLUMNS) {
      if (c.kind === "text") row[c.name] = snap.copyText(c.name, i);
      else if (c.kind === "date") { const ms = snap.copyNum(c.name, i); row[c.name] = ms === null ? null : new Date(ms); }
      else row[c.name] = snap.copyNum(c.name, i);
    }
    out.rows.set(id, row);
    const g = snap.tagsOf("genre", i), k = snap.tagsOf("country", i);
    if (g.length) out.genres.set(id, g);
    if (k.length) out.countries.set(id, k);
  }
  if (fromDb.length) {
    const db = await titleRowsFromDb(fromDb);
    for (const [id, r] of db.rows) out.rows.set(id, r);
    for (const [id, g] of db.genres) out.genres.set(id, g);
    for (const [id, k] of db.countries) out.countries.set(id, k);
  }
  return out;
}
