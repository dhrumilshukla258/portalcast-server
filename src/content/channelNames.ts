// Channel names in catalog titles: "Zee5 : Manemagalu", "Udaya Tv : Madumagalu".
// Pure (no imports) so titleClean.ts can use it; logos live in channels.ts.
//
// The list is curated, not "anything before a colon": that pattern also catches
// franchises ("Star Wars : ...", "Avatar : ...", "Batman : ...") and real titles
// ("Jack Carr Investigates: ..."). Aliases are the spellings seen on real portals.

/** Canonical channel name -> the spellings portals use (lowercase). */
export const CHANNELS: Record<string, string[]> = {
  "HUM TV": ["hum tv", "hum"],
  "ARY Digital": ["ary digital", "ary"],
  "Har Pal Geo": ["har pal geo", "harpal geo", "geo tv", "geo entertainment"],
  "Geo Kahani": ["geo kahani"],
  "Express TV": ["express tv", "express entertainment"],
  "MUN TV": ["mun tv"],
  "Green TV": ["green tv entertainment", "green tv"],
  "TV One": ["tv one"],
  "A Plus": ["a plus entertainment", "a plus"],
  "AAN TV": ["aan tv"],
  "PTV Home": ["ptv home"],
  "Urdu 1": ["urdu 1", "urdu one"],
  "Play Entertainment": ["play entertainment"],
  "Aur Life": ["aur life"],
  "Aaj Entertainment": ["aaj entertainment"],
  "Star Plus": ["star plus"],
  "Star Bharat": ["star bharat"],
  "Star Maa": ["star maa telugu", "star maa"],
  "Star Vijay": ["star vijay tamil", "star vijay", "vijay tv"],
  "Star Suvarna": ["star suvarna"],
  "Star Jalsha": ["star jalsha"],
  "Star Pravah": ["star pravah marathi", "star pravah"],
  "Colors": ["colors tv", "colors"],
  "Colors Kannada": ["colors kannada"],
  "Colors Marathi": ["colors marathi"],
  "Colors Gujarati": ["colors gujarati"],
  "Colors Tamil": ["colors tv tamil", "colors tamil"],
  "Colors Bangla": ["colors bangla"],
  "Zee TV": ["zee tv"],
  "Zee Tamil": ["zee tamil"],
  "Zee Telugu": ["zee telugu"],
  "Zee Kannada": ["zee kannada"],
  "Zee Marathi": ["zee marathi"],
  "Zee Punjabi": ["zee punjabi"],
  "Zee Malayalam": ["zee malayalam", "zee keralam"],
  "Zee Bangla": ["zee bangla", "zee bengali"],
  "Zee5": ["zee5", "zee 5"],
  "Sony TV": ["sony tv", "set entertainment", "sony entertainment television", "sony"],
  "Sony SAB": ["sony sab", "sab tv"],
  "Sony Marathi": ["sony marathi"],
  "Sun TV": ["sun tv tamil", "sun tv"],
  "Sun Neo": ["sun neo"],
  "Gemini TV": ["gemini tv", "gemini"],
  "ETV Telugu": ["etv telugu", "etv"],
  "Asianet": ["asianet"],
  "Kalaignar TV": ["kalaignar tv tamil", "kalaignar tv"],
  "Udaya TV": ["udaya tv", "udaya"],
  "NXT": ["nxt"],
  "Dangal TV": ["dangal tv", "dangal"],
  "&TV": ["and tv", "&tv", "& tv"],
  "MTV": ["mtv"],
};

const ALIASES = Object.entries(CHANNELS)
  .flatMap(([canonical, aliases]) => aliases.map((a) => ({ alias: a, canonical })))
  .sort((a, b) => b.alias.length - a.alias.length); // longest first: "star vijay tamil" before "star vijay"

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// "<channel> : title", "<channel> - title", "<channel> | title". A separator is required, so a
// title that merely starts with a channel's words ("Colors of Love", "Sunrise") is untouched.
const PREFIX_RE = new RegExp(`^\\s*(${ALIASES.map((a) => escape(a.alias)).join("|")})\\s*(?::|\\||\\s-\\s)\\s*(.+)$`, "i");
const CANONICAL = new Map(ALIASES.map((a) => [a.alias, a.canonical]));

export interface ChannelSplit {
  channel: string | null;
  title: string;
}

/** "Zee5 : Manemagalu" -> { channel: "Zee5", title: "Manemagalu" }; no channel -> title as given. */
export function splitChannel(name: string): ChannelSplit {
  const m = PREFIX_RE.exec(String(name || ""));
  if (!m || !m[2].trim()) return { channel: null, title: String(name || "") };
  return { channel: CANONICAL.get(m[1].toLowerCase()) ?? m[1], title: m[2].trim() };
}

