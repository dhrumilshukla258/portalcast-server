// "Not interested" (owner, 2026-10-22: people get bored of seeing the same suggestions): a
// viewer hides a title from their Home rows. Kept in the user's preferences
// (`hiddenTitles`, content ids, newest first, at most 1000), held in memory per user and
// read by content/home.ts; `notInterestedGen` changes with every edit so cached rows are
// rebuilt. Different from the admin's hidden titles (content/overrides.ts), which hide a
// title from everyone everywhere.

import { User } from "@/models/User";

export const MAX_HIDDEN = 1000;
const cache = new Map<number, Set<string>>();
let gen = 0;

export function notInterestedGen(): number { return gen; }

function listOf(prefs: any): string[] {
  const v = prefs?.hiddenTitles;
  return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === "string") : [];
}

/** The titles this user said they are not interested in. */
export async function hiddenFor(userId: number): Promise<Set<string>> {
  const have = cache.get(userId);
  if (have) return have;
  const user = await User.findByPk(userId, { attributes: ["preferences"] });
  const set = new Set(listOf(user?.preferences));
  if (cache.size > 500) cache.clear();
  cache.set(userId, set);
  return set;
}

/** Adds (`hidden`) or removes a title; returns the list, newest first. */
export async function setNotInterested(userId: number, contentId: string, hidden: boolean): Promise<string[]> {
  const user = await User.findByPk(userId);
  if (!user) return [];
  const list = listOf(user.preferences).filter((id) => id !== contentId);
  if (hidden) list.unshift(contentId);
  const next = list.slice(0, MAX_HIDDEN);
  user.preferences = { ...(user.preferences || {}), hiddenTitles: next } as any;
  user.changed("preferences", true);
  await user.save();
  cache.set(userId, new Set(next));
  gen++;
  return next;
}
