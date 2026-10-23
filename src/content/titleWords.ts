// The word lists title cleaning uses (content/titleClean.ts: languages and their spellings,
// quality and other tags, channel names in front of a title), editable per portal profile in
// Admin (owner, 2026-10-23: "we provide a default list; they add and remove per portal").
//
// The defaults are the built-in lists. A profile stores only its changes (system_config
// "title_words_<profileId>"): words added, words removed, a spelling given another language.
// The active profile's changes are applied at start-up, when the active profile changes and
// when they are saved; titles whose cleaning changes are then re-cleaned and regrouped in the
// background (content/metaEnrichment.ts recleanForWords). No changes: exactly the defaults.

import { SystemConfig } from "@/models/SystemConfig";
import { ConfigProfile } from "@/models/ConfigProfile";
import { setTitleWordEdits, defaultTitleWords, type TitleWordEdits } from "@/content/titleClean";
import { getActiveProfileId } from "@/routes/stalkerV2/shared";
import { logger } from "@/infra/logger";

const KEY = (profileId: number) => `title_words_${profileId}`;
const MAX_PER_LIST = 300;
// Words as people type them: letters of any script, digits, spaces and a little punctuation.
const WORD = /^[\p{L}\p{N}][\p{L}\p{N} &+'.!-]{0,59}$/u;

export class TitleWordsError extends Error {}

/** A checked list of words, lowercase unless [keepCase] (an added channel is its badge as typed). */
const words = (raw: unknown, what: string, keepCase = false): string[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new TitleWordsError(`${what} must be a list`);
  if (raw.length > MAX_PER_LIST) throw new TitleWordsError(`${what}: at most ${MAX_PER_LIST} words`);
  const out = new Map<string, string>(); // lowercase -> as kept
  for (const w of raw) {
    const s = String(w ?? "").trim().replace(/\s+/g, " ");
    if (!WORD.test(s)) throw new TitleWordsError(`${what}: "${String(w).slice(0, 40)}" is not a word`);
    if (!out.has(s.toLowerCase())) out.set(s.toLowerCase(), keepCase ? s : s.toLowerCase());
  }
  return [...out.values()];
};

/** Checked and tidied changes (lowercase words, no repeats); throws TitleWordsError. */
export function cleanEdits(raw: any): TitleWordEdits {
  const langAddRaw = raw?.languages?.add ?? [];
  if (!Array.isArray(langAddRaw) || langAddRaw.length > MAX_PER_LIST) throw new TitleWordsError(`languages.add must be a list of at most ${MAX_PER_LIST}`);
  const langAdd = langAddRaw.map((e: any) => {
    const [spelling] = words([e?.spelling], "languages.add spelling");
    const language = String(e?.language ?? "").trim().replace(/\s+/g, " ");
    if (!spelling || !WORD.test(language)) throw new TitleWordsError("languages.add needs a spelling and a language");
    return { spelling, language: language.charAt(0).toUpperCase() + language.slice(1) };
  });
  return {
    languages: { add: langAdd, remove: words(raw?.languages?.remove, "languages.remove") },
    tags: { add: words(raw?.tags?.add, "tags.add"), remove: words(raw?.tags?.remove, "tags.remove") },
    channels: { add: words(raw?.channels?.add, "channels.add", true), remove: words(raw?.channels?.remove, "channels.remove") },
  };
}

const isEmpty = (e: TitleWordEdits | null) =>
  !e || [e.languages?.add, e.languages?.remove, e.tags?.add, e.tags?.remove, e.channels?.add, e.channels?.remove].every((l) => !l?.length);

/** Every word a set of changes touches (for re-cleaning the titles that hold them). */
export function wordsOf(e: TitleWordEdits | null): string[] {
  if (!e) return [];
  return [...(e.languages?.add ?? []).map((a) => a.spelling), ...(e.languages?.remove ?? []), ...(e.tags?.add ?? []), ...(e.tags?.remove ?? []), ...(e.channels?.add ?? []), ...(e.channels?.remove ?? [])];
}

export async function readEdits(profileId: number): Promise<TitleWordEdits | null> {
  const row = await SystemConfig.findByPk(KEY(profileId));
  if (!row?.value || typeof row.value !== "object") return null;
  try { return cleanEdits(row.value); } catch { return null; } // a stored value that no longer checks out: defaults
}

let applied: { profileId: number | undefined; edits: TitleWordEdits | null } = { profileId: undefined, edits: null };
let onChanged: ((words: string[]) => void) | null = null;

/** Called with the words whose cleaning changed (content/metaEnrichment.ts re-cleans those titles). */
export function onTitleWordsChanged(fn: (words: string[]) => void): void {
  onChanged = fn;
}

/**
 * Applies the active profile's changes; re-cleans when they differ from what was applied. At
 * start-up ([startup]) only applies: the stored rows were re-cleaned when the changes were saved.
 */
export async function applyActiveProfileWords(startup = false): Promise<void> {
  const profileId = await getActiveProfileId();
  const edits = profileId === undefined ? null : await readEdits(profileId);
  const before = applied.edits;
  if (applied.profileId === profileId && JSON.stringify(before) === JSON.stringify(edits)) return;
  applied = { profileId, edits };
  setTitleWordEdits(isEmpty(edits) ? null : edits);
  const changed = [...new Set([...wordsOf(before), ...wordsOf(edits)])];
  if (!isEmpty(edits)) logger.info(`[title-words] profile ${profileId}: ${wordsOf(edits).length} words changed from the defaults`);
  if (changed.length && !startup) onChanged?.(changed);
}

/** Saves a profile's changes and applies them when it is the active one. */
export async function saveEdits(profileId: number, raw: unknown): Promise<TitleWordEdits> {
  const edits = cleanEdits(raw);
  await SystemConfig.upsert({ key: KEY(profileId), value: edits });
  if (profileId === (await getActiveProfileId())) await applyActiveProfileWords();
  return edits;
}

/** What Admin shows for a profile: the default lists and its changes. */
export async function describeTitleWords(profileId: number) {
  return { profileId, active: profileId === (await getActiveProfileId()), defaults: defaultTitleWords(), edits: (await readEdits(profileId)) ?? cleanEdits({}) };
}

// A profile switch (or edit) is a write to config_profiles: apply the new active profile's
// words shortly after (several writes in a row are one change).
let timer: NodeJS.Timeout | null = null;
let hooked = false;
export function watchActiveProfile(): void {
  if (hooked) return;
  hooked = true;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void applyActiveProfileWords().catch((e) => logger.warn(`[title-words] not applied: ${e?.message ?? e}`)), 2000);
    timer.unref?.();
  };
  for (const hook of ["afterCreate", "afterUpdate", "afterBulkUpdate", "afterSave", "afterDestroy", "afterBulkDestroy", "afterUpsert"] as const) {
    ConfigProfile.addHook(hook, `title-words-${hook}`, later);
  }
}
