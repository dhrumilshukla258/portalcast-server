// Shared title-cleaning patterns for stripping portal noise (channel prefixes, quality tags,
// dub/language tags) before using a title for grouping (ContentMeta groupKey) or external
// lookups (TMDB search) — one source of truth so both stay in sync.

import { splitChannel, setChannelEdits, CHANNELS } from "@/content/channelNames";

// Portal-supplied names use inconsistent abbreviations/misspellings for the same language
// ("ben", "bangla", "bengali" are all Bengali). Map every known variant to its canonical
// name so "abc hindi", "abc hin", and "abc 4k hindi" all normalize to the same grouping key,
// and so merged filenames show a consistent tag ("[Bengali]") regardless of which spelling
// the portal used.
const LANGUAGE_ALIASES: Record<string, string[]> = {
  // "South Dub"/"South Dubbed" is the portal's own convention for a South
  // Indian film (Tamil/Telugu/Malayalam/Kannada origin) redubbed with Hindi
  // audio — the tag describes the AUDIO TRACK, not a distinct "South"
  // language. Mapping it here (not just QUALITY_TAGS below) means
  // extractVariantTags() correctly reports it as a Hindi variant instead of
  // a raw, meaningless "South Dub" tag.
  //
  // Same reasoning for "Eng Dub"/"English Dub" — on this portal it means the
  // (English-original) content has been dubbed INTO Hindi, not that the
  // audio track is English. Listed before bare "english"/"eng" below in the
  // alternation (longest-match-first, see VARIANT_ALTERNATION) so "Eng Dub"
  // matches this Hindi phrase, not the standalone English tag.
  Hindi:      ["hindi", "hin", "south dub", "south dubbed", "eng dub", "english dub"],
  Tamil:      ["tamil", "tam"],
  Telugu:     ["telugu", "tel"],
  Malayalam:  ["malayalam", "mal"],
  Kannada:    ["kannada", "kan", "kann"],
  Bengali:    ["bengali", "bangla", "ben", "bangali"],
  Punjabi:    ["punjabi", "pun"],
  Marathi:    ["marathi", "mar"],
  Odia:       ["odia", "oriya"],
  Gujarati:   ["gujarati", "gujrati", "guj"],
  Assamese:   ["assamese", "asm"],
  Urdu:       ["urdu"],
  Bhojpuri:   ["bhojpuri", "bhoj"],
  Sindhi:     ["sindhi"],
  English:    ["english", "eng", "en"],
  French:     ["french"],
  Spanish:    ["spanish", "es"],
  German:     ["german"],
  Italian:    ["italian"],
  Portuguese: ["portuguese", "porteguese", "pt"],
  Russian:    ["russian"],
  Arabic:     ["arabic"],
  Chinese:    ["chinese"],
  Japanese:   ["japanese"],
  Korean:     ["korean"],
};

const QUALITY_TAGS = [
  // "South Dub"/"South Dubbed" used to live here as "South\\s+Dubb?", stripped
  // as generic noise — moved into LANGUAGE_ALIASES above instead, since it's
  // actually a Hindi-audio signal, not a meaningless tag. VARIANT_ALTERNATION
  // merges both arrays and sorts by length, so it's still tried as one unit
  // before the standalone "Dubb?" below regardless of which array it's in —
  // "South Dub" won't strip to a dangling "South".
  //
  // NOTE: deliberately no bare "Sub"/"Subbed"/"Subtitled" entry here — real
  // titles legitimately end in "Sub" (e.g. "Narco Sub", about a narco
  // submarine), so stripping it unconditionally corrupts unrelated titles.
  // "Sub" is only ever noise when it directly follows a language name (e.g.
  // "Eng Sub") — see LANGUAGE_SUB_PATTERN below, added to the alternation as
  // one combined unit instead of a standalone quality tag.
  "Dual\\s*Audio", "Dubbed", "Dubb?", "Multi", "TriAudio", "4K", "UHD", "FHD", "HD", "SD", "SDR", "HDR",
  "HDRip", "HDTV", "HDCAM", "BluRay", "Blu-?Ray", "BRRip", "WEBRip", "WEB-?DL", "DVDRip", "DVD-?Rip",
  "CAM", "HDTS", "TS", "PDVD", "480p", "720p", "1080p", "2160p", "CC",
  "Natok", "Notok", // Bengali TV-drama genre suffix (+ common typo) — pure noise, not content-distinguishing
  "Web\\s*Series", // format label, not content-distinguishing (same show listed with/without it)
];

// The channel names taken off the front of a title (stripChannelPrefix below), one regex
// fragment each. Families list the longer names first only for reading: the alternation is
// sorted longest first when built.
// The trailing \b (before the optional separator) is load-bearing — without
// it, these alternatives matched as raw substrings, not whole words, so a
// real title merely starting with the same letters as a channel name got
// silently mutilated: "Maal - Tamil HD" -> "l" (via "Maa"), "Sunrise" -> "rise"
// (via "Sun"), "Colorsplash" -> "plash" (via "Colors"), "Starship Troopers"
// -> "ship troopers" (via "Star") — verified against real catalog data.
// A ":" or "|" after the channel is required: without one "Star Wars : The Clone Wars"
// lost "Star" and "Colors of Love" lost "Colors"; " - " is a film's language/year tag
// ("Dangal - Telugu"), not a channel separator (found 2026-10-19/20).
const family = (base: string, rest: string[]) => [base, ...rest.map((w) => `${base}\\s+${w}`)];
const CHANNEL_PREFIXES = [
  ...family("Colors", ["Kannada", "Tamil", "Gujarati", "Bangla", "Marathi", "Odia", "Punjabi", "Rishtey", "Super", "Infinity"]),
  ...family("Zee", ["TV", "Telugu", "Tamil", "Kannada", "Marathi", "Bangla", "Punjabi", "Malayalam", "Cafe", "Cinema", "News", "Anmol", "Bollywood", "Classic", "Action", "World"]),
  ...family("Star", ["Plus", "Vijay", "Jalsha", "Pravah", "Suvarna", "Maa", "Bharat", "Utsav", "Gold", "World", "Movies", "Sports"]),
  ...family("Sony", ["TV", "SAB", "Liv", "Max", "Aath", "Rox", "Marathi"]),
  ...family("Sun", ["TV", "Bangla", "Marathi", "Neo", "Life"]),
  ...family("Gemini", ["TV", "Music", "Movies"]),
  ...family("Maa", ["TV", "Gold", "Movies"]),
  ...family("ETV", ["Telugu", "Plus", "Andhra"]),
  "Life\\s+OK", "Asianet", "Vijay\\s*TV", "SAB\\s*TV", "Rishtey", "Big\\s+Magic", "Aaj\\s+Tak", "Republic\\s*TV", "NDTV",
  "CNN", "BBC", "Discovery", "National\\s+Geographic", "Nat\\s+Geo", "HUM\\s*TV", "ARY\\s*Digital", "Har\\s*Pal\\s*Geo",
  "MUN\\s*TV", "Dangal\\s*TV", "And\\s*TV", "MTV", "Express\\s*Tv", "Urdu\\s*Tv\\s*Show", "Urdu\\s*1",
  ...family("Untold", ["UK"]),
];

/** A list entry as people write it: "Dual\\s*Audio" -> "dual audio", "Blu-?Ray" -> "blu-ray", "Dubb?" -> "dub". */
const wordOf = (fragment: string) => fragment.replace(/\\s[*+]/g, " ").replace(/-\?/g, "-").replace(/b\?/g, "").toLowerCase();
const escapeWord = (word: string) => word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
const NEVER = "(?!x)x"; // an emptied list must match nothing, not everything

/**
 * One portal's changes to the default word lists (Admin, per profile; content/titleWords.ts).
 * Words are compared lowercase, as people write them ("dual audio", "hum tv"). Null: defaults.
 */
export interface TitleWordEdits {
  /** Spellings of a language: added (or given another language), or removed. */
  languages?: { add?: { spelling: string; language: string }[]; remove?: string[] };
  /** Quality and other tags. */
  tags?: { add?: string[]; remove?: string[] };
  /** Channel names in front of a title. */
  channels?: { add?: string[]; remove?: string[] };
}

/** The patterns built from the lists (defaults, with one portal's changes). */
function buildRules(edits: TitleWordEdits | null) {
  const removedTags = new Set((edits?.tags?.remove ?? []).map((s) => s.trim().toLowerCase()));
  const qualityTags = QUALITY_TAGS.filter((t) => !removedTags.has(wordOf(t)))
    .concat((edits?.tags?.add ?? []).map(escapeWord).filter(Boolean));

  const aliases = new Map<string, string>(); // spelling -> language
  const removedSpellings = new Set((edits?.languages?.remove ?? []).map((s) => s.trim().toLowerCase()));
  for (const [canonical, list] of Object.entries(LANGUAGE_ALIASES)) {
    for (const alias of list) if (!removedSpellings.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), canonical);
  }
  for (const { spelling, language } of edits?.languages?.add ?? []) {
    const s = spelling.trim().toLowerCase().replace(/\s+/g, " ");
    if (s && language.trim()) aliases.set(s, language.trim());
  }
  // Spellings as regex fragments, matched as written (one space between words, as before).
  const spellingRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const spellings = [...aliases.keys()];

  const alt = (xs: string[]) => (xs.length ? [...xs].sort((a, b) => b.length - a.length).join("|") : NEVER);
  // Quality-only alternation (no language tokens) — used where a caller wants
  // just the resolution/format tags on their own, e.g. building a short variant
  // label ("Marathi 4K") instead of dumping the whole raw catalog name.
  const qualityAlternation = alt(qualityTags);
  // Language-only alternation, built before the variant alternation below since it
  // feeds languageSub — a combined "(language) Sub(bed|titled)?" unit,
  // stripped together so grouping treats "Eng Sub" the same way it already
  // treats "Hindi Dub", without ever stripping a bare, unqualified "Sub".
  const languageAlternation = alt(spellings.map(spellingRe));
  const languageSub = `(?:${languageAlternation})\\s+Sub(?:bed|titled)?`;
  // Longest-first so overlapping alternatives (e.g. "gujarati" vs "guj") don't matter —
  // \b boundaries already prevent partial-word matches either way, this just keeps regex
  // alternation deterministic.
  const variantAlternation = alt([...spellings.map(spellingRe), ...qualityTags, languageSub]);
  // The neighbouring tag must be a real one (a full language name, a quality mark), not another
  // short code: in "Kan Kan Men Bhagwan" neither "Kan" is a tag.
  const neighbourTags = alt(spellings.filter((a) => a.length > 3).map(spellingRe).concat(qualityTags, [languageSub]));

  const removedChannels = new Set((edits?.channels?.remove ?? []).map((s) => s.trim().toLowerCase().replace(/\s+/g, " ")));
  const channelPrefixes = CHANNEL_PREFIXES.filter((f) => !removedChannels.has(wordOf(f)))
    .concat((edits?.channels?.add ?? []).map(escapeWord).filter(Boolean));

  return {
    aliases,
    qualityRe: new RegExp(`\\b(${qualityAlternation})\\b`, "gi"),
    variantRe: new RegExp(`\\b(${variantAlternation})\\b`, "gi"),
    // Short language codes ("ben", "mal", "mar", "pt", "en", "hin") are also ordinary words at the
    // start or inside real titles: "Ben 10: Alien Force" became "10: Alien Force", "Bigga Than Ben"
    // "Bigga Than", "PT Sir" "Sir" (80 titles on one catalog; owner, 2026-10-23). A short code is a
    // tag only where something marks it as one: a separator before it ("Title - Ben", "Title (Tam)"),
    // a closing bracket after it, or another tag next to it ("Title Mal HD"). Full language names and
    // quality tags are taken wherever they are, as before.
    shortCodes: new Set(spellings.filter((a) => a.length <= 3)),
    tagBefore: new RegExp(`\\b(?:${neighbourTags})$`, "i"),
    tagAfter: new RegExp(`^(?:${neighbourTags})\\b`, "i"),
    channelPrefixRe: new RegExp(`^(${alt(channelPrefixes)})\\b\\s*([:|\\-])?\\s*`, "i"),
    // Tells an "X Sub" tag apart from an "X Dub"/bare "X" tag — needs looking
    // at the word(s) AROUND a language match, not just matching the language
    // token in isolation the way variantRe does.
    languageTokenRe: new RegExp(`\\b(${languageAlternation})\\b`, "i"),
    subTagRe: new RegExp(`\\b(${languageAlternation})\\s+Sub(?:bed|titled)?\\b`, "i"),
  };
}

let R = buildRules(null);

/** Applies one portal's changes to the lists (null: the defaults); channelNames.ts too. */
export function setTitleWordEdits(edits: TitleWordEdits | null): void {
  R = buildRules(edits);
  setChannelEdits(edits?.channels ?? null);
}

/** The default lists, as Admin shows them (words as people write them). */
export function defaultTitleWords(): { languages: { language: string; spellings: string[] }[]; tags: string[]; channels: string[] } {
  const channels = new Set(CHANNEL_PREFIXES.map(wordOf));
  for (const [canonical, list] of Object.entries(CHANNELS)) { channels.add(canonical.toLowerCase()); for (const a of list) channels.add(a); }
  return {
    languages: Object.entries(LANGUAGE_ALIASES).map(([language, spellings]) => ({ language, spellings: [...spellings] })),
    tags: QUALITY_TAGS.map(wordOf),
    channels: [...channels].sort(),
  };
}

// Returns the distinct quality/format tags found in `name`, in the order they
// appear (e.g. "Pot Luck 4K CC" -> ["4K", "CC"]). Case/spelling as matched in
// the source name, not normalized — these are meant for display, not grouping.
export function extractQualityTags(name: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  name.replace(R.qualityRe, (m) => {
    const key = m.trim().toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(m.trim());
    }
    return m;
  });
  return tags;
}

function stripVariantTags(name: string): string {
  return name.replace(R.variantRe, (match: string, _tag: string, offset: number, all: string) => {
    if (!R.shortCodes.has(match.toLowerCase())) return "";
    const before = all.slice(0, offset).replace(/\s+$/, "");
    const after = all.slice(offset + match.length).replace(/^\s+/, "");
    if (!before) return match; // the first word of a name is the title's
    // Written in capitals at the very end of a name that is not ("Rosa Morena PT"): a tag.
    const capsAtEnd = !after && match.length >= 2 && match === match.toUpperCase() && before !== before.toUpperCase();
    const marked = capsAtEnd || /[-–(\[|:,\/]$/.test(before) || /^[)\]]/.test(after) || R.tagBefore.test(before) || R.tagAfter.test(after);
    return marked ? "" : match;
  });
}

// Strips known channel prefixes and quality/language/dub tags, preserving case and the
// remaining title text as-is (for display or as a search query).
// A one-word channel ("Star", "Colors", "Dangal") counts only before ":" or "|" ("Star Wars",
// "Dangal - Telugu" are titles); a full multi-word channel name ("Colors Marathi Swamini",
// "Star Vijay SPB Oru Kaaviyam") is taken off with or without a separator.
function stripChannelPrefix(name: string): string {
  return name.replace(R.channelPrefixRe, (match, prefix: string, sep?: string) =>
    sep === ":" || sep === "|" || /\s/.test(String(prefix).trim()) ? "" : match);
}

// Turkish dubs and dramas, written only one of two ways on the portal: a trailing tag
// ("Maternal Instinct - Turkish", 673 titles) or a label in front ("Turkish Drama : Hercai").
// Not a general language word: "The Turkish Detective" keeps it.
const TURKISH_TAG_RE = /\s*[-–(\[]\s*turkish\s*[)\]]?\s*$/i;
// Category labels portals put in front of a show's name: taken off, no badge (they are not
// channels). "Turkish Drama : X", "Web Series : X". ("Urdu TV :" is a badge: channelNames.ts.)
const TURKISH_LABEL_RE = /^\s*(?:turkish(?:\s+dramas?)?|web\s+series)\s*:\s*/i;

function stripNoise(name: string): string {
  const withoutLabels = stripChannelPrefix(name).replace(TURKISH_LABEL_RE, "").replace(TURKISH_TAG_RE, "");
  return stripVariantTags(withoutLabels)
    // Removing a tag from "Title - Hindi" or "Title (ES)" leaves the separator behind
    // ("Title -" / "Title ()") — without cleaning it up, two titles differing only by
    // tag never produce the same grouping key ("Title -" !== "Title"), silently
    // defeating the merge this whole module exists for.
    .replace(/[\[\(]\s*[\]\)]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-:|,]+|[\s\-:|,]+$/g, "")
    .trim();
}

/**
 * Channel prefix ("Zee5 : X", from the curated list) and quality/language/dub tags removed.
 * The channel is only taken off when a real title is left behind; otherwise the name is
 * cleaned as if it had no channel.
 */
export function stripReleaseNoise(name: string): string {
  const split = splitChannel(name);
  if (split.channel) {
    const rest = stripNoise(split.title);
    if (rest) return rest;
  }
  return stripNoise(name);
}

/** The channel a title airs on, when its name starts with one and a real title follows. */
export function channelOf(name: string): string | null {
  const split = splitChannel(name);
  return split.channel && stripNoise(split.title) ? split.channel : null;
}

// Same as stripReleaseNoise, but also lowercases — used as a grouping key where case
// shouldn't matter (e.g. matching "Movie Name" and "movie name Hindi" to the same title).
//
// Falls back to the raw (lowercased) name when stripping leaves nothing —
// verified against real catalog data: entries whose ENTIRE name is a channel
// prefix and/or quality/language tag with no actual title text ("Maa", "Maa
// 4K", "Gemini HD", "Star - Tamil", "Bangla", "German", "Untold" all strip to
// "") would otherwise all collapse into one shared groupKey and be treated as
// language/format variants of "the same title," despite being 21 completely
// unrelated catalog entries. The raw-name fallback keeps them distinct
// (grouping only entries with the exact same untouched name together, which
// is still correct — they just don't get the benefit of tag-based grouping).
export function normalizeTitleKey(name: string): string {
  const stripped = stripReleaseNoise(name).toLowerCase();
  // Grouping-key only — stripReleaseNoise only trims stray punctuation at the
  // START/END of a title (a mid-title colon is meaningful for DISPLAY and
  // must be preserved there, e.g. "Title: Subtitle"). But two catalog entries
  // for the same real show can differ only by whether the provider/TMDB
  // happened to include that colon at all ("Murdaugh Murders Deadly Dynasty"
  // vs "Murdaugh Murders: Deadly Dynasty" — same show, two entries that never
  // grouped together) — collapse it everywhere for the key so that no longer
  // splits them into separate groups.
  const collapsed = stripped.replace(/\s*:\s*/g, " ").replace(/\s+/g, " ").trim();
  return collapsed || name.trim().toLowerCase();
}

// TMDB's originalLanguage on ContentMeta is stored as a raw ISO 639-1 code
// (e.g. "pa", "hi") — display code, not a canonical language NAME the way
// LANGUAGE_ALIASES above is keyed. Separate map since a name like "Punjabi"
// and its ISO code "pa" aren't derivable from each other via the alias table.
const ISO_LANGUAGE_NAMES: Record<string, string> = {
  en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", ml: "Malayalam",
  kn: "Kannada", bn: "Bengali", mr: "Marathi", gu: "Gujarati", pa: "Punjabi",
  ur: "Urdu", or: "Odia", as: "Assamese", ne: "Nepali", si: "Sinhala",
  th: "Thai", ko: "Korean", ja: "Japanese", zh: "Chinese", cn: "Chinese",
  es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese",
  ru: "Russian", ar: "Arabic", tr: "Turkish", vi: "Vietnamese", id: "Indonesian",
  ms: "Malay", tl: "Filipino", nl: "Dutch", pl: "Polish", sv: "Swedish",
  fa: "Persian", he: "Hebrew", el: "Greek", cs: "Czech", ro: "Romanian",
  hu: "Hungarian", uk: "Ukrainian", da: "Danish", fi: "Finnish", no: "Norwegian",
  dz: "Dzongkha", cr: "Cree", ab: "Abkhazian", os: "Ossetian", bo: "Tibetan", ik: "Inupiaq",
};

// Maps a raw ISO 639-1 code to its display name, falling back to the
// uppercased code itself for anything not in the table (still better than a
// blank label, and matches the webui's own DiscoverFilters.tsx fallback for
// the same data).
export function languageCodeToName(code: string): string {
  return ISO_LANGUAGE_NAMES[code.toLowerCase()] || code.toUpperCase();
}

export interface LanguageInfo {
  audio: string | null;
  subtitles: string | null;
}

// Distinguishes "X Dub"/bare "X" (the AUDIO is in language X) from "X Sub"
// (original audio kept, subtitled in X — X is NOT the audio language).
// Conflating these would mislabel, e.g., a Korean film with English
// subtitles as if its audio track were English.
export function extractLanguageInfo(name: string): LanguageInfo {
  const subMatch = name.match(R.subTagRe);
  const subtitles = subMatch ? R.aliases.get(subMatch[1].toLowerCase()) ?? null : null;

  // Search for an audio-language token on whatever's left after removing the
  // matched "X Sub" span (if any) — otherwise "Eng Sub" would also match
  // "Eng" a second time as if it were a separate, additional audio signal.
  const remaining = subMatch
    ? name.slice(0, subMatch.index!) + name.slice(subMatch.index! + subMatch[0].length)
    : name;

  // Only trust a language match in the trailing "tag cluster" (after the last
  // -/(/[  separator), not anywhere in the title text — verified against real
  // catalog data that a real title can legitimately contain a language name as
  // an ordinary word (e.g. "The German Lesson - DUBBED"), which an unanchored
  // search would misread as a German-audio tag. Titles with no such separator
  // have no reliable tag position, so they're left unknown (null) rather than
  // risk a false positive — better to say "we don't know" than guess wrong.
  const lastSeparator = Math.max(remaining.lastIndexOf("-"), remaining.lastIndexOf("("), remaining.lastIndexOf("["));
  const tagCluster = lastSeparator >= 0 ? remaining.slice(lastSeparator) : null;

  const audioMatch = tagCluster?.match(R.languageTokenRe);
  const audio = audioMatch ? R.aliases.get(audioMatch[1].toLowerCase()) ?? null : null;

  return { audio, subtitles };
}

// Category names on this portal (e.g. "Hindi | Dubbed", "Hindi | Web Series")
// directly state the AUDIO of everything filed under them — a much more
// reliable signal than parsing the raw catalog title (which this specific
// portal's own tags can contradict, e.g. "Eng Dub" meaning Hindi audio, see
// LANGUAGE_ALIASES) and NOT the same thing as ContentMeta.originalLanguage
// (TMDB's production-language field — correct for "what language was this
// movie originally made in," but wrong for "what audio does this specific
// catalog file have," which is what a variant label needs to answer). No
// tag-cluster restriction here unlike extractLanguageInfo — category names
// are short, curated strings, not free-text titles, so an unanchored search
// is safe.
export function extractLanguageFromCategoryName(categoryName: string): string | null {
  const match = categoryName.match(R.languageTokenRe);
  return match ? R.aliases.get(match[1].toLowerCase()) ?? null : null;
}
