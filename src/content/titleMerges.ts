import { SystemConfig } from "@/models/SystemConfig";

// Titles the admin merged (owner 2026-11-05): two or three entries that are one film or show
// but did not group as versions ("Dune: Part One" from the NAS beside the portal's "Dune": the
// same TMDB id, different names). A merge sends every copy of one title (its group key) to
// another title's group. groupKeyFor (content/metaEnrichment.ts) applies it wherever a group is
// computed, so matching, the regroup and the library keep it, and new copies of the merged title
// follow. Kept in system_config, the same for every profile (a film is the same film anywhere).

export interface TitleMerge {
  type: "movie" | "series";
  /** The group key merged away ("movie:dune part one:tmdb438631"). */
  from: string;
  /** The group key it joined. */
  to: string;
  fromName: string;
  toName: string;
  at: string;
}

const CONFIG_KEY = "title_merges";
let merges: TitleMerge[] = [];
let resolved = new Map<string, string>();

/** A group key after the merges ("movie:dune part one:tmdb438631" -> "movie:dune:tmdb438631"). */
export function mergedKey(key: string): string {
  return resolved.get(key) ?? key;
}

/** Follows chains (A into B, B into C: A into C); a loop is never stored (mergeTitles). */
export function resolveMerges(list: TitleMerge[]): Map<string, string> {
  const next = new Map(list.map((m) => [m.from, m.to]));
  const out = new Map<string, string>();
  for (const from of next.keys()) {
    let to = next.get(from)!;
    const seen = new Set([from]);
    while (next.has(to) && !seen.has(to)) { seen.add(to); to = next.get(to)!; }
    out.set(from, to);
  }
  return out;
}

function use(list: TitleMerge[]): void {
  merges = list;
  resolved = resolveMerges(list);
}

/** At startup, before the catalog is grouped (server.ts). */
export async function loadTitleMerges(): Promise<void> {
  const row = await SystemConfig.findByPk(CONFIG_KEY);
  use(Array.isArray(row?.value) ? (row!.value as TitleMerge[]) : []);
}

export function listTitleMerges(): TitleMerge[] {
  return merges.map((m) => ({ ...m, to: mergedKey(m.from) }));
}

/** [key] and the keys it was merged into, in order. */
function chainOf(key: string): string[] {
  const next = new Map(merges.map((m) => [m.from, m.to]));
  const out = [key];
  let k = key;
  while (next.has(k)) {
    k = next.get(k)!;
    if (out.includes(k)) break;
    out.push(k);
  }
  return out;
}

/** Why [from] cannot be merged into [to], or null. */
export function mergeProblem(from: string, to: string): string | null {
  if (!from || !to) return "Both titles need a group";
  if (from.split(":")[0] !== to.split(":")[0]) return "A movie can only be merged with a movie, a show with a show";
  if (mergedKey(from) === mergedKey(to)) return "They are already one title";
  // [to] must not lead back to [from]: that would merge the title into itself.
  if (chainOf(to).includes(from)) return "That would merge the title into itself";
  return null;
}

/** Records the merge (replacing an earlier one of [from]); the rows are moved by the caller. */
export async function addTitleMerge(m: Omit<TitleMerge, "at">): Promise<void> {
  const list = [...merges.filter((x) => x.from !== m.from), { ...m, at: new Date().toISOString() }];
  await SystemConfig.upsert({ key: CONFIG_KEY, value: list });
  use(list);
}

/** Forgets the merge of [from]; false when there was none. */
export async function removeTitleMerge(from: string): Promise<boolean> {
  if (!merges.some((m) => m.from === from)) return false;
  const list = merges.filter((m) => m.from !== from);
  await SystemConfig.upsert({ key: CONFIG_KEY, value: list });
  use(list);
  return true;
}
