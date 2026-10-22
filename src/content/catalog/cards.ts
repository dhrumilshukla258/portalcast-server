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
import { peopleOf, personCredits, unpackPhoto, type PersonRow, type PersonCredit } from "@/content/people";
import type { CatalogSnapshot } from "./snapshot";
import { catalogReady, catalogChanges, COPY_COLUMNS, type CatalogChanges } from "./store";
import { shadowCheck } from "./shadow";

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

/** A row as comparable values (the snapshot's columns as the database holds them), for the
 *  shadow check: a Sequelize row, a raw row and a snapshot row of the same data are equal. */
function canonRow(r: any): unknown[] | null {
  if (!r) return null;
  return COPY_COLUMNS.map((c) => {
    const v = r[c.name];
    if (v === null || v === undefined) return null;
    if (c.kind === "text") return String(v);
    if (c.kind === "date") {
      return v instanceof Date ? v.getTime() : Date.parse(String(v).replace(/^(\S+) (\S+) ?([+-]\d\d:?\d\d|Z)?$/, (_m: string, d: string, t: string, z?: string) => `${d}T${t}${z ?? "Z"}`));
    }
    return Number(v);
  });
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
  const canon = (t: TitleRows) => JSON.stringify([...new Set(ids)].sort().map((id) => [id, canonRow(t.rows.get(id)), t.genres.get(id) ?? [], t.countries.get(id) ?? []]));
  shadowCheck("card rows and tags", canon(out), async () => canon(await titleRowsFromDb(ids)));
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
      const found = { row, members: [row, ...group.filter((g) => g.id !== row.id)] };
      const canon = (f: { members: any[] } | null) => JSON.stringify(f ? f.members.map(canonRow) : null);
      shadowCheck("title versions", canon(found), async () => canon(await titleWithGroupFromDb(id)));
      return found;
    }
  }
  return titleWithGroupFromDb(id);
}

async function titleWithGroupFromDb(id: string): Promise<{ row: any; members: any[] } | null> {
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
      rows.sort((a, b) => rep(b) - rep(a) || binaryCmp(a.name, b.name));
      const canon = (list: any[]) => JSON.stringify(list.map(canonRow));
      shadowCheck("versions picker", canon(rows), async () => canon(await variantRowsFromDb(id, hidden)));
      return rows;
    }
  }
  return variantRowsFromDb(id, hidden);
}

async function variantRowsFromDb(id: string, hidden: string[]): Promise<any[]> {
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
  const rows = await titlePeopleFrom(src, keys);
  shadowCheck("cast and crew", JSON.stringify(rows), async () => JSON.stringify(await peopleOf(keys)));
  return rows;
}

async function titlePeopleFrom(src: { snap: CatalogSnapshot; changes: CatalogChanges }, keys: string[]): Promise<PersonRow[]> {
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

// ── a person's titles ──────────────────────────────────────────────────────────

/**
 * The titles a person is credited on, one card per title (people.ts personCredits over the
 * snapshot, same rules and order). Read from the database instead when anything about titles,
 * tags or credits changed since the build, or this person did: their titles could be any.
 */
export async function personTitles(id: number): Promise<PersonCredit[]> {
  const src = await source();
  const changed = !src || ["title", "tags", "credits"].some((t) => (src.changes.keys.get(t)?.size ?? 0) > 0) || src.changes.has("person", String(id));
  const pi = src && !changed ? src.snap.personIndex(id) : -1;
  if (!src || pi < 0) return personCredits(id);
  const snap = src.snap;
  const links = snap.personCredits(pi);
  if (!links.length) return [];
  const rolesByKey = new Map<string, { kind: string; role: string | null }[]>();
  for (const l of links) {
    const list = rolesByKey.get(l.titleKey) ?? [];
    if (!list.some((x) => x.kind === l.kind && x.role === l.role)) list.push({ kind: l.kind, role: l.role });
    rolesByKey.set(l.titleKey, list);
  }
  const leadKeys = new Set(links.filter((l) => l.kind !== "writer" && (l.kind !== "cast" || l.order < 3)).map((l) => l.titleKey));
  const isRep = (c: number) => !!snap.copyNum("isRepresentative", c);
  // The group's representative, preferring a representative row (personCredits' pickRep).
  const pickRep = (copies: number[]): number => {
    if (!copies.length) return -1;
    const rep = copies.find(isRep) ?? copies[0];
    if (isRep(rep) || !snap.copyText("groupKey", rep)) return rep;
    return snap.groupOf(rep).find(isRep) ?? rep;
  };
  const out = new Map<string, PersonCredit>();
  const keys = [...rolesByKey.keys()];
  const add = (k: string, c: number) => {
    if (c < 0) return;
    const cid = snap.copyText("id", c)!;
    const have = out.get(cid);
    if (!have) out.set(cid, { row: snapshotRow(snap, c), roles: rolesByKey.get(k)!, lead: leadKeys.has(k) });
    else if (/^(movie|series):\d+$/.test(k)) have.roles.push(...rolesByKey.get(k)!);
  };
  for (const k of keys.filter((x) => /^(movie|series):\d+$/.test(x))) {
    const [t, n] = k.split(":");
    add(k, pickRep(snap.copiesByTmdb(t as "movie" | "series", Number(n))));
  }
  for (const k of keys.filter((x) => !/^(movie|series):\d+$/.test(x))) {
    const c = snap.copyIndex(k);
    add(k, c < 0 ? -1 : pickRep([c]));
  }
  const titles = [...out.values()].sort((a, b) => (Number(b.row.year) || 0) - (Number(a.row.year) || 0) || String(a.row.name).localeCompare(String(b.row.name)));
  const canon = (list: PersonCredit[]) => JSON.stringify(list.map((c) => [canonRow(c.row), c.roles, c.lead]));
  shadowCheck("a person's titles", canon(titles), async () => canon(await personCredits(id)));
  return titles;
}
