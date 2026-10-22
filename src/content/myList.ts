// My List (plan Phase 6.5): titles a viewer saved to watch later. A viewer is a user on the
// active IPTV profile, as for watch progress. One row per title (primary key), so a title is
// never in a list twice; newest first. This module is the only writer of user_list
// (test/ownership.test.ts).

import { QueryTypes } from "sequelize";
import { sequelize } from "@/db";

/** At most this many titles per viewer: a list, not a second catalog. */
export const MAX_LIST = 1000;
/** A catalog title id ("movie_123", "series_L4"). */
export const CONTENT_ID = /^(movie|series)_[\w.-]{1,120}$/;

export interface ListEntry { contentId: string; addedAt: number }

const q = (sql: string, replacements: unknown[]) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT }) as Promise<any[]>;

/** The viewer's list, most recently added first. */
export async function listOf(userId: number, profileId: number): Promise<ListEntry[]> {
  const rows = await q("SELECT contentId, addedAt FROM user_list WHERE userId = ? AND profileId = ? ORDER BY addedAt DESC, contentId", [userId, profileId]);
  return rows.map((r) => ({ contentId: String(r.contentId), addedAt: Number(r.addedAt) }));
}

export type AddResult = "added" | "already" | "full" | "invalid";

/** Adds a title (kept where it was when already there). */
export async function addToList(userId: number, profileId: number, contentId: string): Promise<AddResult> {
  if (!CONTENT_ID.test(contentId)) return "invalid";
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM user_list WHERE userId = ? AND profileId = ?", [userId, profileId]);
  const [have] = await q("SELECT 1 AS ok FROM user_list WHERE userId = ? AND profileId = ? AND contentId = ?", [userId, profileId, contentId]);
  if (have) return "already";
  if (Number(n) >= MAX_LIST) return "full";
  await sequelize.query("INSERT OR IGNORE INTO user_list (userId, profileId, contentId, addedAt) VALUES (?, ?, ?, ?)", {
    replacements: [userId, profileId, contentId, Date.now()],
  });
  return "added";
}

/** Removes a title; true when it was there. */
export async function removeFromList(userId: number, profileId: number, contentId: string): Promise<boolean> {
  const [have] = await q("SELECT 1 AS ok FROM user_list WHERE userId = ? AND profileId = ? AND contentId = ?", [userId, profileId, contentId]);
  if (!have) return false;
  await sequelize.query("DELETE FROM user_list WHERE userId = ? AND profileId = ? AND contentId = ?", { replacements: [userId, profileId, contentId] });
  return true;
}
