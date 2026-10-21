// The only writer of the tag tables (content_genres, content_countries, content_themes).
// Every write goes through here so the rules hold everywhere: a title's tags are replaced as a
// set, each value once (TMDB and NFO lists can repeat a genre), and the UNIQUE (value, contentId)
// index added by the "unique-tags" storage step refuses any repeat that slips through.
// test/ownership.test.ts fails if another module writes these tables.

import { Op, QueryTypes, Transaction } from "sequelize";
import { ContentGenre } from "@/models/ContentGenre";
import { ContentCountry } from "@/models/ContentCountry";
import { ContentTheme } from "@/models/ContentTheme";

export type TagModel = typeof ContentGenre | typeof ContentCountry | typeof ContentTheme;

/** Trimmed, non-empty, each value once, first spelling kept. */
export function uniqueTagValues(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = String(raw ?? "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Replaces one kind of tag of `contentId` with `values` (deduplicated). */
export async function replaceTags(
  Model: TagModel,
  contentId: string,
  values: string[],
  opts: { transaction?: Transaction; isRepresentative?: boolean } = {},
): Promise<void> {
  const { transaction, isRepresentative } = opts;
  await (Model as any).destroy({ where: { contentId }, transaction });
  const unique = uniqueTagValues(values);
  if (unique.length === 0) return;
  await (Model as any).bulkCreate(
    unique.map((value) => (isRepresentative === undefined ? { contentId, value } : { contentId, value, isRepresentative })),
    { transaction, ignoreDuplicates: true },
  );
}

/** Removes every tag of the given titles (a title deleted or merged into another). */
export async function removeAllTags(contentIds: string | string[], transaction?: Transaction): Promise<void> {
  const ids = Array.isArray(contentIds) ? contentIds : [contentIds];
  if (ids.length === 0) return;
  const where = { contentId: ids.length === 1 ? ids[0] : { [Op.in]: ids } };
  await ContentGenre.destroy({ where, transaction });
  await ContentCountry.destroy({ where, transaction });
  await ContentTheme.destroy({ where, transaction });
}

/** How many tags of `contentId` of one kind exist (the scanner fills NFO tags only when none). */
export async function tagCount(Model: TagModel, contentId: string): Promise<number> {
  return (Model as any).count({ where: { contentId } });
}

/** Marks the tags of `contentId` as belonging to the shown (representative) row of its group. */
export async function markTagsRepresentative(contentId: string, transaction?: Transaction): Promise<void> {
  for (const Model of [ContentGenre, ContentCountry, ContentTheme] as TagModel[]) {
    await (Model as any).update({ isRepresentative: true }, { where: { contentId }, transaction });
  }
}

/**
 * The statements that copy the representative flag onto the tag tables after
 * db/index.ts recomputeRepresentatives() filled temp.rep_ids (run on its connection).
 */
export function representativeTagStatements(): string[] {
  return ["content_genres", "content_countries", "content_themes"].flatMap((table) => [
    `UPDATE \`${table}\` SET \`isRepresentative\` = 1 WHERE \`isRepresentative\` IS NOT 1 AND \`contentId\` IN (SELECT \`id\` FROM temp.\`rep_ids\`);`,
    `UPDATE \`${table}\` SET \`isRepresentative\` = 0 WHERE \`isRepresentative\` IS NOT 0 AND \`contentId\` NOT IN (SELECT \`id\` FROM temp.\`rep_ids\`);`,
  ]);
}

/** Deletes tags whose title no longer exists (integrity job repair). Returns rows removed. */
export async function removeOrphanTags(): Promise<number> {
  const sequelize = (ContentGenre as any).sequelize;
  let removed = 0;
  for (const table of ["content_genres", "content_countries", "content_themes"]) {
    // One transaction: the count read with changes() is this DELETE's, not another query's.
    removed += await sequelize.transaction(async (transaction: Transaction) => {
      await sequelize.query(`DELETE FROM \`${table}\` WHERE contentId NOT IN (SELECT id FROM content_meta)`, { transaction });
      const [{ n }] = await sequelize.query("SELECT changes() AS n", { transaction, type: QueryTypes.SELECT });
      return Number(n) || 0;
    });
  }
  return removed;
}
