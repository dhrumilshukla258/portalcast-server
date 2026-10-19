// Prepared per-category browse lists (normalised + content-manager overrides applied),
// kept in memory so paging a category is O(page) instead of O(category).
//
// Before: every page of a category that missed the ContentCache table re-read and
// re-parsed the whole category list, copied every item, applied overrides to all of them
// and wrote that one page back to SQLite — ~300 ms for the largest live movie category
// (20,757 titles) to return 14 items, repeated for every new page number.
//
// An entry is valid while (a) the category's cached list has not been rewritten
// (xtreamCacheKeyVersion) and (b) no override changed (overridesGeneration), and for at
// most TTL_MS, after which the route re-reads it through getOrRefresh* so staleness-driven
// portal refreshes keep working. LRU-bounded so memory stays flat no matter how many
// categories users browse.

import { overridesGeneration } from "@/content/overrides";
import { xtreamCacheKeyVersion } from "@/services/xtreamCache";

const MAX_ENTRIES = 24;
const TTL_MS = 10 * 60 * 1000;

interface Entry { fp: string; at: number; list: any[] }
const memo = new Map<string, Entry>();

const fingerprint = (listKey: string) => `${overridesGeneration()}|${xtreamCacheKeyVersion(listKey)}`;

/** The prepared list for `slot` if still valid (refreshes its LRU position), else null. */
export function peekCategoryList(slot: string, listKey: string): any[] | null {
  const e = memo.get(slot);
  if (!e) return null;
  if (e.fp !== fingerprint(listKey) || Date.now() - e.at > TTL_MS) {
    memo.delete(slot);
    return null;
  }
  memo.delete(slot);
  memo.set(slot, e);
  return e.list;
}

export function putCategoryList(slot: string, listKey: string, list: any[]): void {
  memo.delete(slot);
  memo.set(slot, { fp: fingerprint(listKey), at: Date.now(), list });
  while (memo.size > MAX_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

export function clearCategoryLists(): void {
  memo.clear();
}
