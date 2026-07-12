// Shared title-cleaning patterns for stripping portal noise (channel prefixes, quality tags,
// dub/language tags) before using a title for grouping (strmGenerator) or external lookups
// (TMDB search) — one source of truth so both stay in sync.

const VARIANT_RE =
  /\b(Hindi|Tamil|Telugu|Malayalam|Kannada|Bengali|Punjabi|Marathi|Odia|Gujarati|Assamese|Urdu|Bhojpuri|Sindhi|English|French|Spanish|German|Italian|Portuguese|Russian|Arabic|Chinese|Japanese|Korean|Dual\s*Audio|Dubbed|Multi|TriAudio|4K|UHD|FHD|HD|SD|SDR|HDR|HDRip|HDTV|HDCAM|BluRay|Blu-?Ray|BRRip|WEBRip|WEB-?DL|DVDRip|DVD-?Rip|CAM|HDTS|TS|PDVD|480p|720p|1080p|2160p)\b/gi;

const CHANNEL_PREFIX_RE = /^(Colors(?:\s+(?:Kannada|Tamil|Gujarati|Bangla|Marathi|Odia|Punjabi|Rishtey|Super|Infinity))?|Zee(?:\s+(?:TV|Telugu|Tamil|Kannada|Marathi|Bangla|Cafe|Cinema|News|Anmol|Bollywood|Classic|Action|World))?|Star(?:\s+(?:Plus|Vijay|Jalsha|Pravah|Suvarna|Maa|Utsav|Gold|World|Movies|Sports))?|Sony(?:\s+(?:TV|SAB|Liv|Max|Aath|Rox|Marathi))?|Sun(?:\s+(?:TV|Bangla|Marathi|Neo|Life))?|Gemini(?:\s+(?:TV|Music|Movies))?|Maa(?:\s+(?:TV|Gold|Movies))?|ETV(?:\s+(?:Telugu|Plus|Andhra))?|Life\s+OK|Asianet|Vijay\s*TV|SAB\s*TV|Rishtey|Big\s+Magic|Aaj\s+Tak|Republic\s*TV|NDTV|CNN|BBC|Discovery|National\s+Geographic|Nat\s+Geo)\s*/i;

// Strips known channel prefixes and quality/language/dub tags, preserving case and the
// remaining title text as-is (for display or as a search query).
export function stripReleaseNoise(name: string): string {
  return name
    .replace(CHANNEL_PREFIX_RE, "")
    .replace(VARIANT_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Same as stripReleaseNoise, but also lowercases — used as a grouping key where case
// shouldn't matter (e.g. matching "Movie Name" and "movie name Hindi" to the same title).
export function normalizeTitleKey(name: string): string {
  return stripReleaseNoise(name).toLowerCase();
}

export function extractVariantTags(name: string): string[] {
  const tags: string[] = [];
  const ch = name.match(CHANNEL_PREFIX_RE);
  if (ch) tags.push(ch[0].trim());
  name.replace(VARIANT_RE, (m) => { tags.push(m.trim()); return ""; });
  return tags;
}
