// Title data for Discover from the catalog snapshot (plan, Phase 1b): card rows and tags,
// a title's group (every version of it), and its cast and crew. Whatever was written after the
// snapshot was built is read from the database as before: a title's row or tags (change log
// "title" / "tags"), a credit list ("credits") or a person on it ("person"), and every group a
// changed title belonged to then or belongs to now. The change log is read on every call
// (store.catalogChanges), so a write made a moment ago is never missed. With the snapshot off,
// every function here is the database read the routes did before.

import { Op, QueryTypes } from "sequelize";
import { sequelize } from "@/db";
import { setting } from "@/config/settings";
import { ContentMeta } from "@/models/ContentMeta";
import { ContentGenre } from "@/models/ContentGenre";
import { ContentCountry } from "@/models/ContentCountry";
import { peopleOf, unpackPhoto, type PersonRow } from "@/content/people";
import type { CatalogSnapshot } from "./snapshot";
import { catalogReady, catalogChanges, COPY_COLUMNS, type CatalogChanges } from "./store";

export interface TitleRows {
  /** content id -> row (the snapshot's columns, as stored; a Sequelize row for database reads). */
  rows: Map<string, any>;
  genres: Map<string, string[]>;
  countries: Map<string, string[]>;
}

/** The snapshot and what changed since, or null when the snapshot is off or not there. */
async function source(): Promise<{ snap: CatalogSnapshot; changes: CatalogChanges } | null> {
  if (!setting<boolean>("catalogSnapshot")) return null;
  const snap = await catalogReady();
  const changes = snap ? await catalogChanges() : null;
  return snap && changes && changes.snap === snap ? { snap, changes } : null;
}

/** A content_meta row as the snapshot holds it (dates as Date, like a Sequelize row). */
function snapshotRow(snap: CatalogSnapshot, i: number): Record<string, any> {
  const row: Record<string, any> = {};
  for (const c of COPY_COLUMNS) {
    if (c.kind === "text") row[c.name] = snap.copyText(c.name, i);
    else if (c.kind === "date") { const ms = snap.copyNum(c.name, i); row[c.name] = ms === null ? null : new Date(ms); }
    else row[c.name] = snap.copyNum(c.name, i);
  }
  return row;
}

/** Copy index of a title unchanged since the snapshot, or -1 (read it from the database). */
function unchangedCopy(src: { snap: CatalogSnapshot; changes: CatalogChanges }, id: string, withTags = false): number {
  const i = src.snap.copyIndex(id);
  if (i < 0 || src.changes.has("title", id) || (withTags && src.changes.has("tags", id))) return -1;
  return i;
}

// ── card rows and tags ─────────────────────────────────────────────────────────

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

async function titleRowsFromDb(ids: string[]): Promise<TitleRows> {
  const found = ids.length ? await ContentMeta.findAll({ where: { id: { [Op.in]: ids } } }) : [];
  const [genres, countries] = await Promise.all([tagsFromDb(ContentGenre, ids), tagsFromDb(ContentCountry, ids)]);
  return { rows: new Map(found.map((r: any) => [r.id as string, r])), genres, countries };
}

/** Rows and genre/country tags for `ids` (Discover cards). */
export async function titleRows(ids: string[]): Promise<TitleRows> {
  const src = await source();
  if (!src) return titleRowsFromDb(ids);
  const out: TitleRows = { rows: new Map(), genres: new Map(), countries: new Map() };
  const fromDb: string[] = [];
  for (const id of new Set(ids)) {
    const i = unchangedCopy(src, id, true);
    if (i < 0) { fromDb.push(id); continue; }
    out.rows.set(id, snapshotRow(src.snap, i));
    const g = src.snap.tagsOf("genre", i), k = src.snap.tagsOf("country", i);
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

// ── groups ─────────────────────────────────────────────────────────────────────

/** Current groupKey of each changed title (re-read when it changes again), per snapshot. */
let groupState: { snap: CatalogSnapshot; groupOf: Map<string, { seq: number; groupKey: string | null }>; dirty: Set<string>; seq: number } | null = null;

/** Groups touched by a title change since the snapshot: its group then, and its group now. */
async function dirtyGroups(src: { snap: CatalogSnapshot; changes: CatalogChanges }): Promise<Set<string>> {
  if (!groupState || groupState.snap !== src.snap) groupState = { snap: src.snap, groupOf: new Map(), dirty: new Set(), seq: -1 };
  const state = groupState;
  if (state.seq === src.changes.seq) return state.dirty;
  const titles = src.changes.keys.get("title") ?? new Map<string, number>();
  const stale = [...titles].filter(([id, seq]) => state.groupOf.get(id)?.seq !== seq);
  for (let k = 0; k < stale.length; k += 500) {
    const batch = stale.slice(k, k + 500);
    const rows = (await sequelize.query(`SELECT id, groupKey FROM content_meta WHERE id IN (${batch.map(() => "?").join(",")})`, {
      replacements: batch.map(([id]) => id), type: QueryTypes.SELECT,
    })) as { id: string; groupKey: string | null }[];
    const now = new Map(rows.map((r) => [r.id, r.groupKey]));
    for (const [id, seq] of batch) state.groupOf.set(id, { seq, groupKey: now.get(id) ?? null });
  }
  const dirty = new Set<string>();
  for (const id of titles.keys()) {
    const now = state.groupOf.get(id)?.groupKey;
    if (now) dirty.add(now);
    const i = src.snap.copyIndex(id);
    const then = i >= 0 ? src.snap.copyText("groupKey", i) : null;
    if (then) dirty.add(then);
  }
  state.dirty = dirty;
  state.seq = src.changes.seq;
  return dirty;
}

/**
 * A title's row and the rows of every version of it (its groupKey), the title first, then
 * the others in stored order — what titleDetails read with findByPk + findAll({ groupKey }).
 * Null for an unknown id.
 */
export async function titleWithGroup(id: string): Promise<{ row: any; members: any[] } | null> {
  const src = await source();
  const i = src ? unchangedCopy(src, id) : -1;
  if (src && i >= 0) {
    const groupKey = src.snap.copyText("groupKey", i);
    if (!groupKey || !(await dirtyGroups(src)).has(groupKey)) {
      const row = snapshotRow(src.snap, i);
      const group = groupKey ? src.snap.groupOf(i).map((c) => (c === i ? row : snapshotRow(src.snap, c))) : [row];
      return { row, members: [row, ...group.filter((g) => g.id !== row.id)] };
    }
  }
  const row = await ContentMeta.findByPk(id);
  if (!row) return null;
  const group = row.groupKey ? await ContentMeta.findAll({ where: { groupKey: row.groupKey } }) : [row];
  return { row, members: [row, ...group.filter((g) => g.id !== row.id)] };
}

/** UTF-8 byte order (SQLite's BINARY collation), NULL first as in ORDER BY ... ASC. */
function binaryCmp(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Every version of the title `id` belongs to, minus hidden ones, representative first then by
 * name (the variants picker): findAll({ groupKey, id NOT IN hidden }, ORDER BY isRepresentative
 * DESC, name ASC). Empty when the title has no group.
 */
export async function variantRows(id: string, hidden: string[]): Promise<any[]> {
  const src = await source();
  const i = src ? unchangedCopy(src, id) : -1;
  if (src && i >= 0) {
    const groupKey = src.snap.copyText("groupKey", i);
    if (!groupKey) return [];
    if (!(await dirtyGroups(src)).has(groupKey)) {
      const hide = new Set(hidden);
      const rows = src.snap.groupOf(i).map((c) => snapshotRow(src.snap, c)).filter((r) => !hide.has(r.id));
      // NULL sorts lowest, so last in DESC; ties keep stored order (the sort is stable).
      const rep = (r: any) => (r.isRepresentative === null ? -Infinity : r.isRepresentative);
      return rows.sort((a, b) => rep(b) - rep(a) || binaryCmp(a.name, b.name));
    }
  }
  const anchor = (await ContentMeta.findByPk(id, { raw: true })) as any;
  if (!anchor || !anchor.groupKey) return [];
  return ContentMeta.findAll({
    where: { groupKey: anchor.groupKey, ...(hidden.length > 0 ? { id: { [Op.notIn]: hidden } } : {}) },
    order: [["isRepresentative", "DESC"], ["name", "ASC"]],
  });
}

// ── cast and crew ──────────────────────────────────────────────────────────────

/** People of the first key that has any, in billing order (content/people.ts peopleOf). */
export async function titlePeople(keys: string[]): Promise<PersonRow[]> {
  const src = await source();
  if (!src) return peopleOf(keys);
  for (const key of [...new Set(keys)]) {
    let rows: PersonRow[] | null = null;
    if (!src.changes.has("credits", key)) {
      const credits = src.snap.creditsOf(key);
      const people = credits.map((c) => src.snap.person(c.person));
      // A person written since (renamed, new photo, merged) is read from the database.
      if (!people.some((p) => src.changes.has("person", String(p.id)))) {
        rows = credits.map((c, k) => ({
          id: people[k].id, kind: c.kind, name: people[k].name, role: c.role,
          photo: unpackPhoto(people[k].photo), tmdbPersonId: people[k].tmdbPersonId,
        }));
      }
    }
    if (rows === null) rows = await peopleOf([key]);
    if (rows.length) return rows;
  }
  return [];
}
