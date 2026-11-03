// Shows a provider lists one season at a time ("Lost: Season 2", "Asianet : Mylanchi S07",
// "The Simpsons : Season 1 to 10") are one show with all its seasons (owner, 2026-11-03).
//
// - Grouping (metaEnrichment.ts groupKeyFor): the season marker is left out of a series' group
//   key, so the parts of one show share a group, as language/format versions already do.
// - Versions: parts with a different audio language stay different versions (Game of Thrones
//   in "HINDI | DUBBED" is the Hindi version); the version picker shows one entry per language.
// - Seasons (routes/stalkerV2/seasonMerge.ts): opening the show lists the seasons of every part
//   of that language. A merged season's id names the parts it comes from ("m:2:15362.2"), so the
//   episode and play requests that carry it back are routed without any remembered state.
// - The same season in two parts (an HD copy and a cam copy): one season, each episode taken
//   from the best copy that has it, the rest filled from the others.
//
// Everything here is pure (no I/O) so it is tested on real catalog names.

import { normalizeTitleKey, extractLanguageInfo, extractLanguageFromCategoryName, extractQualityTags } from "@/content/titleClean";
import { episodeNumberOf } from "@/content/tmdbEpisodes";

export interface SeasonMarker {
  /** The show's key without the marker ("lost"). */
  base: string;
  /** First season named; with [to], a range. */
  from: number;
  /** Last season named; null = "to current"; equal to [from] for one season. */
  to: number | null;
}

const SEP = String.raw`(?:^|[\s\-–:|,.(])\s*`;
const CURRENT = String.raw`cur+ent|onwards`;
const RANGE_RE = new RegExp(
  String.raw`${SEP}seasons?\s*0*(\d{1,3})\s*(?:-|–|to|&|and|,)\s*(?:s(?:eason)?\s*)?0*(\d{1,3}|${CURRENT})\b.*$`,
);
const SINGLE_RE = new RegExp(String.raw`${SEP}season\s*0*(\d{1,3})\b\s*(?:(?:to|-|–|&)?\s*(${CURRENT})|\+)?\s*[).]?\s*$`);
const SHORT_RE = new RegExp(String.raw`${SEP}s0*(\d{1,2})(?:\s*(?:&|and|-|–|to)\s*(?:s?0*(\d{1,2})|(${CURRENT})))?\s*[).]?\s*$`);
// A year after the marker ("Bigg Boss Telugu S10 2026") is the airing year, not the title.
const TRAILING_YEAR = /\s+[(\[]?(?:19|20)\d{2}[)\]]?$/;

/** The season marker at the end of a series name, read on its grouping key. */
export function seasonMarkerOf(name: string): SeasonMarker | null {
  const key = normalizeTitleKey(name).replace(TRAILING_YEAR, "");
  for (const re of [RANGE_RE, SINGLE_RE, SHORT_RE]) {
    const m = re.exec(key);
    if (!m) continue;
    const base = key.slice(0, m.index).replace(/[\s\-–:|,.(]+$/, "").trim();
    if (!base) return null; // the whole name is "Season 2": nothing to call the show
    const from = Number(m[1]);
    if (!(from >= 0 && from < 1000)) return null;
    let to: number | null = from;
    const end = m[3] ?? m[2];
    if (end && !/^\d+$/.test(end)) to = null;
    else if (end) to = Number(end);
    if (to !== null && to < from) to = from;
    return { base, from, to };
  }
  return null;
}

/** A series' name for display without its season marker: "Lost: Season 2" -> "Lost". */
export function withoutSeasonMarker(name: string): string {
  const text = String(name || "").replace(TRAILING_YEAR, "");
  for (const re of [RANGE_RE, SINGLE_RE, SHORT_RE]) {
    const m = new RegExp(re.source, "i").exec(text);
    if (!m) continue;
    const base = text.slice(0, m.index).replace(/[\s\-–:|,.(]+$/, "").trim();
    return base || name;
  }
  return name;
}

/** A series' grouping name: its key without a season marker. */
export function seriesBaseKey(name: string): string {
  return seasonMarkerOf(name)?.base ?? normalizeTitleKey(name);
}

/**
 * The audio language of one provider copy: its category's ("HINDI | DUBBED": the audio is
 * Hindi, owner 2026-11-03), else its own tags ("Holy Faak Hindi S01"), else "".
 * "SOUTH | DUBBED" is South Indian films with Hindi audio, as "South Dub" is in titles.
 */
export function audioLanguageOf(name: string, categoryName: string | undefined | null): string {
  const cat = String(categoryName || "");
  if (/\bsouth\b/i.test(cat) && /\bdub/i.test(cat)) return "Hindi";
  return (cat && extractLanguageFromCategoryName(cat)) || extractLanguageInfo(name).audio || "";
}

const QUALITY_RANK: [RegExp, number][] = [
  [/^(4k|uhd|2160p)$/i, 5],
  [/^(fhd|1080p|bluray|blu-?ray|brrip)$/i, 4],
  [/^(hd|720p|hdrip|web-?dl|webrip|hdtv)$/i, 3],
  [/^(sd|480p|dvdrip|dvd-?rip|pdvd)$/i, 2],
  [/^(cam|hdcam|hdts|ts)$/i, 1],
];

/** 0 (unknown) to 5 (4K), from a name's quality words or a badge ("4k"). */
export function qualityRankOf(name: string, badge?: string | null): number {
  let best = 0;
  for (const tag of [...extractQualityTags(name), ...(badge ? [badge] : [])]) {
    for (const [re, rank] of QUALITY_RANK) if (re.test(tag.trim())) best = Math.max(best, rank);
  }
  return best;
}

// ---- merged season ids -----------------------------------------------------------------

export interface SeasonSource { part: string; season: string }

/** "m:2:15362.2~20983.5602": season 2, from these parts' seasons, best first. */
export function encodeSeasonId(n: number, sources: SeasonSource[]): string {
  return `m:${n}:` + sources.map((s) => `${s.part}.${s.season}`).join("~");
}

export function decodeSeasonId(id: unknown): { n: number; sources: SeasonSource[] } | null {
  const m = /^m:(\d{1,4}):(.+)$/.exec(String(id ?? ""));
  if (!m) return null;
  const sources: SeasonSource[] = [];
  for (const piece of m[2].split(/[~+ ]/)) {
    const dot = piece.indexOf(".");
    if (dot <= 0) return null;
    const part = piece.slice(0, dot);
    const season = piece.slice(dot + 1);
    if (!/^\d+$/.test(part) || !/^[\w-]+$/.test(season)) return null;
    sources.push({ part, season });
  }
  return sources.length ? { n: Number(m[1]), sources } : null;
}

// ---- merging ----------------------------------------------------------------------------

export interface PartSeasons {
  /** Provider series id ("15362"). */
  id: string;
  name: string;
  /** Quality rank of the copy (qualityRankOf). */
  quality: number;
  /** The part is the title that was opened (first among equals). */
  opened?: boolean;
  /** The provider's season items for this part. */
  seasons: any[];
}

function providerSeasonNumber(item: any): number | null {
  const n = Number(item?.season_number);
  if (n >= 0 && Number.isFinite(n) && String(item?.season_number ?? "") !== "") return n;
  const m = /season\s*0*(\d{1,3})/i.exec(String(item?.name ?? item?.season_name ?? ""));
  if (m) return Number(m[1]);
  const id = Number(item?.id);
  return Number.isInteger(id) && id >= 0 && id < 100 ? id : null; // Xtream: the id is the number
}

/**
 * The real season number of each of a part's seasons. The name decides when it names one
 * season and the provider lists one ("Mylanchi S07" filed as season 1 is season 7); a range
 * ("Season 16 To Current") keeps the provider's numbers, moved up into the range when they
 * all fall below it. Otherwise the provider's numbers stand.
 */
export function numberSeasons(part: PartSeasons): { n: number; item: any }[] {
  const marker = seasonMarkerOf(part.name);
  const items = part.seasons.filter((s) => s && s.id != null);
  const nums = items.map(providerSeasonNumber);
  if (marker && marker.to === marker.from && items.length === 1) return [{ n: marker.from, item: items[0] }];
  if (marker && items.length > 0 && nums.every((n) => n != null)) {
    const min = Math.min(...(nums as number[]));
    const shift = min < marker.from ? marker.from - min : 0;
    return items.map((item, i) => ({ n: (nums[i] as number) + shift, item }));
  }
  return items.flatMap((item, i) => (nums[i] == null ? [] : [{ n: nums[i] as number, item }]));
}

/**
 * One season list from the parts of one show (same language). A season several parts have is
 * listed once, its id naming every part that has it, the best copy first (quality, then the
 * opened title, then the part with that season alone in its name). Newest season first, as
 * providers list them.
 */
export function mergeSeasonLists(parts: PartSeasons[]): any[] {
  const byNumber = new Map<number, { part: PartSeasons; item: any }[]>();
  for (const part of parts) {
    for (const { n, item } of numberSeasons(part)) {
      const list = byNumber.get(n) ?? [];
      list.push({ part, item });
      byNumber.set(n, list);
    }
  }
  const out: any[] = [];
  for (const n of [...byNumber.keys()].sort((a, b) => b - a)) {
    const list = byNumber.get(n)!;
    const exact = (p: PartSeasons) => { const m = seasonMarkerOf(p.name); return m && m.from === n && m.to === n ? 1 : 0; };
    list.sort((a, b) => b.part.quality - a.part.quality || Number(!!b.part.opened) - Number(!!a.part.opened) || exact(b.part) - exact(a.part));
    const best = list[0];
    const sources = list.map((s) => ({ part: s.part.id, season: String(s.item.id) }));
    out.push({
      ...best.item,
      id: encodeSeasonId(n, sources),
      video_id: best.part.id,
      season_number: String(n),
      name: `Season ${n}`,
      season_name: `Season ${n}`,
    });
  }
  return out;
}

const BARE_EPISODE_TITLE = /^\s*(?:episode|ep\.?)?\s*\d{1,4}\s*[.:\-–]?\s*(?:(?:episode|ep\.?)\s*\d{1,4})?\s*$/i;

/** True when an episode has a title of its own, not just "Episode 25. Episode 25". */
function hasOwnTitle(item: any): boolean {
  const name = String(item?.name ?? item?.title ?? "");
  return !BARE_EPISODE_TITLE.test(name);
}

/**
 * One episode list from the copies of one season, given best copy first: each episode number
 * from the best copy that has it (a better quality never loses to a worse one; at the same
 * quality, a real title beats "Episode 25"), the rest filled in from the others. Episodes
 * without a number are kept from the best copy only. Ordered as the longest copy orders them.
 */
export function mergeEpisodeLists(copies: { quality: number; items: any[] }[]): any[] {
  if (copies.length === 0) return [];
  if (copies.length === 1) return copies[0].items;
  const chosen = new Map<number, { quality: number; item: any }>();
  const unnumbered: any[] = [];
  copies.forEach((copy, ci) => {
    for (const item of copy.items) {
      const n = episodeNumberOf(item);
      if (n == null) { if (ci === 0) unnumbered.push(item); continue; }
      const have = chosen.get(n);
      const quality = Math.max(copy.quality, qualityRankOf("", item?.quality_badge));
      if (!have || quality > have.quality || (quality === have.quality && !hasOwnTitle(have.item) && hasOwnTitle(item))) {
        chosen.set(n, { quality, item });
      }
    }
  });
  // The order of the copy with the most episodes (providers list newest first or oldest first).
  const longest = copies.reduce((a, b) => (b.items.length > a.items.length ? b : a));
  const order = longest.items.map(episodeNumberOf).filter((n): n is number => n != null);
  const descending = order.length > 1 ? order[0] > order[order.length - 1] : false;
  const numbers = [...chosen.keys()].sort((a, b) => (descending ? b - a : a - b));
  return [...numbers.map((n) => chosen.get(n)!.item), ...unnumbered];
}

/**
 * A show's versions for the picker when it has season parts: one per audio language, since
 * opening any of them shows all of that language's seasons. The kept copy is the first given
 * (the representative comes first), else a full series over a season part. Rows of a group
 * without season parts are returned as they are.
 */
export function onePerLanguage<T extends { id: string; name: string; type?: string }>(rows: T[], languageOf: (row: T) => string): T[] {
  if (!rows.some((r) => (r.type ?? "series") === "series" && seasonMarkerOf(r.name))) return rows;
  const raw = new Map(rows.map((r) => [r.id, languageOf(r)]));
  const known = new Set([...raw.values()].filter(Boolean));
  const lang = (r: T) => raw.get(r.id) || (known.size === 1 ? [...known][0] : "");
  const kept = new Map<string, T>();
  rows.forEach((r, i) => {
    const l = lang(r);
    const have = kept.get(l);
    if (!have) { kept.set(l, r); return; }
    if (i > 0 && rows[0] === have) return; // the representative stays
    if (seasonMarkerOf(have.name) && !seasonMarkerOf(r.name)) kept.set(l, r);
  });
  return rows.filter((r) => kept.get(lang(r)) === r);
}
