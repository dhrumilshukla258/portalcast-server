// Cast and crew, stored once (speed plan, data model step).
//
//   people        one row per person: TMDB person id, name, photo
//   title_people  who is in a title: title key, person, kind, role (character), order
//
// The title key is "<type>:<tmdbId>" for a title TMDB knows, so every copy of it (Hindi,
// Tamil, HD, the NAS file) shares one cast list; a title TMDB does not know uses its own
// content id. A local title whose NFO is locked keeps its own list under its content id,
// which the reader checks first. Replaced `content_people` (one row per person per copy:
// 1.65M rows, 170 MB + 33 MB index on the live data).
//
// TMDB w185 photos are stored as their file path ("/abc.jpg") and expanded when read.

import { QueryTypes, Transaction } from "sequelize";
import { ContentMeta } from "@/models/ContentMeta";

export interface PersonEntry {
  kind: string; // cast | director | writer | creator
  name: string;
  role: string | null;
  order: number;
  tmdbPersonId: number | null;
  photo: string | null;
}

const TMDB_W185 = "https://image.tmdb.org/t/p/w185/";
const db = () => ContentMeta.sequelize!;

const packPhoto = (p: string | null) => (p && p.startsWith(TMDB_W185) ? p.slice(TMDB_W185.length - 1) : p);
export const unpackPhoto = (p: string | null) => (p && p.startsWith("/") ? `${TMDB_W185}${p.slice(1)}` : p);

/** The shared key of a title row: "<type>:<tmdbId>", or its content id when TMDB has none. */
export function titleKeyOf(row: { id: string; type: string; tmdbId?: number | null }): string {
  return row.tmdbId ? `${row.type === "series" ? "series" : "movie"}:${row.tmdbId}` : row.id;
}

/** Replaces the people of `titleKey` (one transaction when given). */
export async function storePeople(titleKey: string, people: PersonEntry[], transaction?: Transaction): Promise<void> {
  const q = (sql: string, replacements: any[] = [], select = false) =>
    db().query(sql, { replacements, transaction, ...(select ? { type: QueryTypes.SELECT } : {}) });
  await q("DELETE FROM title_people WHERE titleKey = ?", [titleKey]);
  if (!people.length) return;

  // Persons with a TMDB id: one row each, name and photo kept current.
  const withId = people.filter((p) => p.tmdbPersonId);
  const idOf = new Map<number, number>();
  for (let i = 0; i < withId.length; i += 200) {
    const slice = withId.slice(i, i + 200);
    await q(
      `INSERT INTO people (tmdbPersonId, name, photo) VALUES ${slice.map(() => "(?, ?, ?)").join(", ")}
       ON CONFLICT(tmdbPersonId) DO UPDATE SET name = excluded.name, photo = COALESCE(excluded.photo, people.photo)`,
      slice.flatMap((p) => [p.tmdbPersonId, p.name, packPhoto(p.photo)]),
    );
    const rows = (await q(
      `SELECT id, tmdbPersonId FROM people WHERE tmdbPersonId IN (${slice.map(() => "?").join(", ")})`,
      slice.map((p) => p.tmdbPersonId),
      true,
    )) as any[];
    for (const r of rows) idOf.set(Number(r.tmdbPersonId), Number(r.id));
  }
  // Persons without one (names from an NFO): matched by name.
  const byName = new Map<string, number>();
  for (const p of people.filter((x) => !x.tmdbPersonId)) {
    if (byName.has(p.name)) continue;
    const found = (await q("SELECT id FROM people WHERE tmdbPersonId IS NULL AND name = ? LIMIT 1", [p.name], true)) as any[];
    if (found.length) byName.set(p.name, Number(found[0].id));
    else {
      await q("INSERT INTO people (tmdbPersonId, name, photo) VALUES (NULL, ?, ?)", [p.name, packPhoto(p.photo)]);
      const [{ id }] = (await q("SELECT last_insert_rowid() AS id", [], true)) as any[];
      byName.set(p.name, Number(id));
    }
  }

  const links = people
    .map((p) => ({ p, personId: p.tmdbPersonId ? idOf.get(p.tmdbPersonId) : byName.get(p.name) }))
    .filter((x): x is { p: PersonEntry; personId: number } => !!x.personId);
  for (let i = 0; i < links.length; i += 150) {
    const slice = links.slice(i, i + 150);
    await q(
      `INSERT INTO title_people (titleKey, personId, kind, role, sortOrder) VALUES ${slice.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      slice.flatMap(({ p, personId }) => [titleKey, personId, p.kind, p.role, p.order]),
    );
  }
}

export interface PersonRow { id: number; kind: string; name: string; role: string | null; photo: string | null; tmdbPersonId: number | null }

/** People of the first key that has any, in order. */
export async function peopleOf(keys: string[]): Promise<PersonRow[]> {
  for (const key of [...new Set(keys)]) {
    const rows = (await db().query(
      `SELECT p.id, tp.kind, p.name, tp.role, p.photo, p.tmdbPersonId FROM title_people tp JOIN people p ON p.id = tp.personId
       WHERE tp.titleKey = ? ORDER BY tp.sortOrder`,
      { replacements: [key], type: QueryTypes.SELECT },
    )) as PersonRow[];
    if (rows.length) return rows.map((r) => ({ ...r, photo: unpackPhoto(r.photo) }));
  }
  return [];
}

const DETAILS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PersonDetails {
  id: number;
  name: string;
  photo: string | null;
  tmdbPersonId: number | null;
  biography: string | null;
  knownFor: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
}

/**
 * A person with their biography and the like: from the table, fetched from TMDB the first
 * time the page is opened and refreshed after 30 days (one TMDB call per person, not per
 * view). Null for an unknown id.
 */
export async function personDetails(id: number, fetchPerson: (tmdbId: number) => Promise<any | null>): Promise<PersonDetails | null> {
  const q = (sql: string, r: any[]) => db().query(sql, { replacements: r, type: QueryTypes.SELECT }) as Promise<any[]>;
  const [row] = await q("SELECT * FROM people WHERE id = ?", [id]);
  if (!row) return null;
  const checked = row.detailsCheckedAt ? Date.parse(row.detailsCheckedAt) : 0;
  if (row.tmdbPersonId && (!checked || Date.now() - checked > DETAILS_MAX_AGE_MS)) {
    const t = await fetchPerson(Number(row.tmdbPersonId)).catch(() => null);
    if (t) {
      row.biography = t.biography; row.knownFor = t.knownFor; row.birthday = t.birthday;
      row.deathday = t.deathday; row.placeOfBirth = t.placeOfBirth;
      if (t.photo) row.photo = packPhoto(t.photo);
    }
    // Recorded only when TMDB answered: a network failure is tried again on the next open.
    if (t) await db().query(
      "UPDATE people SET biography = ?, knownFor = ?, birthday = ?, deathday = ?, placeOfBirth = ?, photo = ?, detailsCheckedAt = ? WHERE id = ?",
      { replacements: [row.biography ?? null, row.knownFor ?? null, row.birthday ?? null, row.deathday ?? null, row.placeOfBirth ?? null, row.photo ?? null, new Date().toISOString(), id] },
    );
  }
  return {
    id: Number(row.id), name: row.name, photo: unpackPhoto(row.photo), tmdbPersonId: row.tmdbPersonId ?? null,
    biography: row.biography ?? null, knownFor: row.knownFor ?? null, birthday: row.birthday ?? null,
    deathday: row.deathday ?? null, placeOfBirth: row.placeOfBirth ?? null,
  };
}

/**
 * A person's titles in the catalog, one row per title (the card Discover shows for it), with
 * every way they worked on it (cast as "Ip Man", director, writer...). Titles only in TMDB are
 * not listed: the page shows what can be played.
 */
export async function personCredits(id: number): Promise<{ row: any; roles: { kind: string; role: string | null }[] }[]> {
  const q = (sql: string, r: any[] = []) => db().query(sql, { replacements: r, type: QueryTypes.SELECT }) as Promise<any[]>;
  const links = await q("SELECT titleKey, kind, role, sortOrder FROM title_people WHERE personId = ?", [id]);
  if (!links.length) return [];
  const rolesByKey = new Map<string, { kind: string; role: string | null }[]>();
  for (const l of links) {
    const list = rolesByKey.get(l.titleKey) ?? [];
    if (!list.some((x) => x.kind === l.kind && x.role === l.role)) list.push({ kind: l.kind, role: l.role });
    rolesByKey.set(l.titleKey, list);
  }
  // Keys are "<type>:<tmdbId>" or a content id; each becomes the card Discover shows (the
  // group's representative), preferring a representative row.
  const out = new Map<string, { row: any; roles: { kind: string; role: string | null }[] }>();
  const keys = [...rolesByKey.keys()];
  const byTmdb = keys.filter((k) => /^(movie|series):\d+$/.test(k));
  const byId = keys.filter((k) => !/^(movie|series):\d+$/.test(k));
  const pickRep = async (rows: any[]) => {
    if (!rows.length) return null;
    const rep = rows.find((r) => r.isRepresentative) ?? rows[0];
    if (rep.isRepresentative || !rep.groupKey) return rep;
    const [g] = await q("SELECT * FROM content_meta WHERE groupKey = ? AND isRepresentative = 1 LIMIT 1", [rep.groupKey]);
    return g ?? rep;
  };
  for (let i = 0; i < byTmdb.length; i += 200) {
    const slice = byTmdb.slice(i, i + 200);
    const pairs = slice.map((k) => k.split(":"));
    const rows = await q(
      `SELECT * FROM content_meta WHERE ${pairs.map(() => "(type = ? AND tmdbId = ?)").join(" OR ")}`,
      pairs.flatMap(([t, n]) => [t, Number(n)]),
    );
    for (const k of slice) {
      const [t, n] = k.split(":");
      const rep = await pickRep(rows.filter((r) => r.type === t && Number(r.tmdbId) === Number(n)));
      if (rep && !out.has(rep.id)) out.set(rep.id, { row: rep, roles: rolesByKey.get(k)! });
      else if (rep) out.get(rep.id)!.roles.push(...rolesByKey.get(k)!);
    }
  }
  for (const k of byId) {
    const rows = await q("SELECT * FROM content_meta WHERE id = ?", [k]);
    const rep = await pickRep(rows);
    if (rep && !out.has(rep.id)) out.set(rep.id, { row: rep, roles: rolesByKey.get(k)! });
  }
  return [...out.values()].sort((a, b) => (Number(b.row.year) || 0) - (Number(a.row.year) || 0) || String(a.row.name).localeCompare(String(b.row.name)));
}

/** How many people `titleKey` has. */
export async function peopleCount(titleKey: string): Promise<number> {
  const [{ n }] = (await db().query("SELECT count(*) AS n FROM title_people WHERE titleKey = ?", {
    replacements: [titleKey],
    type: QueryTypes.SELECT,
  })) as any[];
  return Number(n) || 0;
}

/** Nightly: lists of titles no longer in the catalog, then persons in no list. */
export async function tidyPeople(): Promise<string> {
  await db().query(`
    DELETE FROM title_people WHERE titleKey NOT IN (
      SELECT id FROM content_meta
      UNION SELECT type || ':' || tmdbId FROM content_meta WHERE tmdbId IS NOT NULL)`);
  const [{ a }] = (await db().query("SELECT changes() AS a", { type: QueryTypes.SELECT })) as any[];
  await db().query("DELETE FROM people WHERE id NOT IN (SELECT personId FROM title_people)");
  const [{ b }] = (await db().query("SELECT changes() AS b", { type: QueryTypes.SELECT })) as any[];
  return `${a} title lists and ${b} persons no longer used removed`;
}
