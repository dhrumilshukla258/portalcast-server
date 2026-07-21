// Shared title-cleaning patterns for stripping portal noise (channel prefixes, quality tags,
// dub/language tags) before using a title for grouping (strmGenerator) or external lookups
// (TMDB search) — one source of truth so both stay in sync.

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

// Quality-only alternation (no language tokens) — used where a caller wants
// just the resolution/format tags on their own, e.g. building a short variant
// label ("Marathi 4K") instead of dumping the whole raw catalog name.
const QUALITY_ALTERNATION = [...QUALITY_TAGS].sort((a, b) => b.length - a.length).join("|");
const QUALITY_RE = new RegExp(`\\b(${QUALITY_ALTERNATION})\\b`, "gi");

// Returns the distinct quality/format tags found in `name`, in the order they
// appear (e.g. "Pot Luck 4K CC" -> ["4K", "CC"]). Case/spelling as matched in
// the source name, not normalized — these are meant for display, not grouping.
export function extractQualityTags(name: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  name.replace(QUALITY_RE, (m) => {
    const key = m.trim().toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(m.trim());
    }
    return m;
  });
  return tags;
}

const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(LANGUAGE_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_CANONICAL.set(alias.toLowerCase(), canonical);
}

// Language-only alternation, built before VARIANT_ALTERNATION below since it
// feeds LANGUAGE_SUB_PATTERN — a combined "(language) Sub(bed|titled)?" unit,
// stripped together so grouping treats "Eng Sub" the same way it already
// treats "Hindi Dub", without ever stripping a bare, unqualified "Sub".
const LANGUAGE_ALTERNATION = [...ALIAS_TO_CANONICAL.keys()].sort((a, b) => b.length - a.length).join("|");
const LANGUAGE_SUB_PATTERN = `(?:${LANGUAGE_ALTERNATION})\\s+Sub(?:bed|titled)?`;

// Longest-first so overlapping alternatives (e.g. "gujarati" vs "guj") don't matter —
// \b boundaries already prevent partial-word matches either way, this just keeps regex
// alternation deterministic.
const VARIANT_ALTERNATION = [...ALIAS_TO_CANONICAL.keys(), ...QUALITY_TAGS, LANGUAGE_SUB_PATTERN]
  .sort((a, b) => b.length - a.length)
  .join("|");

const VARIANT_RE = new RegExp(`\\b(${VARIANT_ALTERNATION})\\b`, "gi");

// The trailing \b (before the optional separator) is load-bearing — without
// it, these alternatives matched as raw substrings, not whole words, so a
// real title merely starting with the same letters as a channel name got
// silently mutilated: "Maal - Tamil HD" -> "l" (via "Maa"), "Sunrise" -> "rise"
// (via "Sun"), "Colorsplash" -> "plash" (via "Colors"), "Starship Troopers"
// -> "ship troopers" (via "Star") — verified against real catalog data.
const CHANNEL_PREFIX_RE = /^(Colors(?:\s+(?:Kannada|Tamil|Gujarati|Bangla|Marathi|Odia|Punjabi|Rishtey|Super|Infinity))?|Zee(?:\s+(?:TV|Telugu|Tamil|Kannada|Marathi|Bangla|Punjabi|Malayalam|Cafe|Cinema|News|Anmol|Bollywood|Classic|Action|World))?|Star(?:\s+(?:Plus|Vijay|Jalsha|Pravah|Suvarna|Maa|Bharat|Utsav|Gold|World|Movies|Sports))?|Sony(?:\s+(?:TV|SAB|Liv|Max|Aath|Rox|Marathi))?|Sun(?:\s+(?:TV|Bangla|Marathi|Neo|Life))?|Gemini(?:\s+(?:TV|Music|Movies))?|Maa(?:\s+(?:TV|Gold|Movies))?|ETV(?:\s+(?:Telugu|Plus|Andhra))?|Life\s+OK|Asianet|Vijay\s*TV|SAB\s*TV|Rishtey|Big\s+Magic|Aaj\s+Tak|Republic\s*TV|NDTV|CNN|BBC|Discovery|National\s+Geographic|Nat\s+Geo|HUM\s*TV|ARY\s*Digital|Har\s*Pal\s*Geo|MUN\s*TV|Dangal\s*TV|And\s*TV|MTV|Express\s*Tv|Urdu\s*Tv\s*Show|Urdu\s*1|Untold(?:\s+UK)?)\b\s*[:\-]?\s*/i;

// Strips known channel prefixes and quality/language/dub tags, preserving case and the
// remaining title text as-is (for display or as a search query).
export function stripReleaseNoise(name: string): string {
  return name
    .replace(CHANNEL_PREFIX_RE, "")
    .replace(VARIANT_RE, "")
    // Removing a tag from "Title - Hindi" or "Title (ES)" leaves the separator behind
    // ("Title -" / "Title ()") — without cleaning it up, two titles differing only by
    // tag never produce the same grouping key ("Title -" !== "Title"), silently
    // defeating the merge this whole module exists for.
    .replace(/[\[\(]\s*[\]\)]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-:|,]+|[\s\-:|,]+$/g, "")
    .trim();
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
  return stripped || name.trim().toLowerCase();
}

export function extractVariantTags(name: string): string[] {
  const tags: string[] = [];
  const ch = name.match(CHANNEL_PREFIX_RE);
  if (ch) tags.push(ch[0].trim());
  name.replace(VARIANT_RE, (m) => {
    tags.push(ALIAS_TO_CANONICAL.get(m.trim().toLowerCase()) || m.trim());
    return "";
  });
  return tags;
}

// Reuses LANGUAGE_ALTERNATION (declared above, feeding LANGUAGE_SUB_PATTERN)
// to tell an "X Sub" tag apart from an "X Dub"/bare "X" tag — needs looking
// at the word(s) AROUND a language match, not just matching the language
// token in isolation the way extractVariantTags()/VARIANT_RE do.
const LANGUAGE_TOKEN_RE = new RegExp(`\\b(${LANGUAGE_ALTERNATION})\\b`, "i");
const SUB_TAG_RE = new RegExp(`\\b(${LANGUAGE_ALTERNATION})\\s+Sub(?:bed|titled)?\\b`, "i");

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
  const subMatch = name.match(SUB_TAG_RE);
  const subtitles = subMatch ? ALIAS_TO_CANONICAL.get(subMatch[1].toLowerCase()) ?? null : null;

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

  const audioMatch = tagCluster?.match(LANGUAGE_TOKEN_RE);
  const audio = audioMatch ? ALIAS_TO_CANONICAL.get(audioMatch[1].toLowerCase()) ?? null : null;

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
  const match = categoryName.match(LANGUAGE_TOKEN_RE);
  return match ? ALIAS_TO_CANONICAL.get(match[1].toLowerCase()) ?? null : null;
}
