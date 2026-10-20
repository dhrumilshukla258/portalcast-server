// Channel names in catalog titles: "Zee5 : Manemagalu", "Udaya Tv : Madumagalu".
// Pure (no imports) so titleClean.ts can use it; logos live in channels.ts.
//
// The list is curated, not "anything before a colon": that pattern also catches
// franchises ("Star Wars : ...", "Avatar : ...", "Batman : ...") and real titles
// ("Jack Carr Investigates: ..."). Aliases are the spellings seen on real portals.

/** Canonical channel name -> the spellings portals use (lowercase). */
export const CHANNELS: Record<string, string[]> = {
  "HUM TV": ["hum tv drama", "hum tv", "hum"],
  "ARY Digital": ["ary digital drama", "ary digital", "ary digita", "ary"],
  "ARY Zindagi": ["ary zindagi"],
  "Har Pal Geo": ["har pal geo", "harpal geo", "geo tv", "geo entertainment"],
  "Geo Kahani": ["geo kahani"],
  "Express TV": ["express tv", "express entertainment"],
  "MUN TV": ["mun tv"],
  "Green TV": ["green tv entertainment", "green entertainment", "green tv"],
  "TV One": ["tv one"],
  "A Plus": ["a plus entertainment", "aplus entertainment", "aplus tv", "a plus"],
  "AAN TV": ["aan tv", "ann tv"],
  "PTV Home": ["ptv home"],
  "PTV": ["ptv"],
  "Hey TV": ["hey tv"],
  "Bol Entertainment": ["bol entertainment"],
  "SAB TV Pakistan": ["sab tv pakistan"],
  "Urdu 1": ["urdu 1", "urdu one"],
  // Not one real channel but a generic "Urdu TV" label portals use for Pakistani dramas;
  // shown as a badge all the same. Only a filter if Live TV has a channel by that name.
  "Urdu TV": ["urdu tv show", "urdu tv", "urdu show"],
  "Play Entertainment": ["play entertainment tv", "play entertainment", "play tv"],
  "Aur Life": ["aur life"],
  "Aaj Entertainment": ["aaj entertainment"],
  "Star Plus": ["star plus"],
  "Star Bharat": ["star bharat"],
  "Star Maa": ["star maa telugu", "star maa"],
  "Star Vijay": ["star vijay tamil", "star vijay", "vijay tv"],
  "Star Suvarna": ["star suvarna kannada", "star suvarna"],
  "Star Jalsha": ["star jalsha bangla", "star jalsha"],
  "Star World": ["star world"],
  "Star Pravah": ["star pravah marathi", "star pravah"],
  "Colors": ["colors tv", "colors"],
  "Colors Kannada": ["colors kannada"],
  "Colors Marathi": ["colors marathi"],
  "Colors Gujarati": ["colors gujarati", "colors gujrati"],
  "Colors Tamil": ["colors tv tamil", "colors tamil"],
  "Colors Bangla": ["colors bangla", "colors bengali"],
  "Zee TV": ["zee tv"],
  "Zee Zindagi": ["zee zindagi"],
  "Zee Anmol": ["zee anmol"],
  "Zee Zest": ["zee zest"],
  "Zing": ["zing"],
  "Big Magic": ["big magic"],
  "Zee Tamil": ["zee tamil"],
  "Zee Telugu": ["zee telugu"],
  "Zee Kannada": ["zee kannada"],
  "Zee Marathi": ["zee marathi"],
  "Zee Punjabi": ["zee punjabi"],
  "Zee Malayalam": ["zee malayalam", "zee keralam"],
  "Zee Bangla": ["zee bangla", "zee bengali"],
  // Streaming services, written the same way ("Zee5 : X"). Not in Live TV, so they are cleaned
  // and badged but never offered as a Channel filter. "Amazon"/"Prime" are left out on
  // purpose: "Amazon Empire", "Prime Suspect", "Primeval" are titles.
  "Zee5": ["zee5 originals", "zee5 marathi", "zee5", "zee 5"],
  "SonyLIV": ["sony liv", "sonyliv", "sony live"],
  "JioHotstar": ["jiohotstar", "hotstar", "jiocinema", "jio cinema"],
  "Voot": ["voot tv", "voot"],
  "Aha": ["aha"],
  "Sun NXT": ["sun nxt"],
  "Sony TV": ["sony tv", "set entertainment", "sony entertainment television", "sony"],
  "Sony SAB": ["sony sab", "sab tv"],
  "Sony Marathi": ["sony marathi"],
  "Sun TV": ["sun tv tamil", "sun tv"],
  "Sun Bangla": ["sun bangla"],
  "Sun Marathi": ["sun marathi"],
  "Sun Neo": ["sun neo tv", "sun neo"],
  "Gemini TV": ["gemini tv telugu", "gemini tv", "gemini"],
  "ETV Telugu": ["etv telugu", "etv"],
  "ETV Kannada": ["etv kannada"],
  "Asianet": ["asianet malayalam", "asiannet malayalam", "asiannet", "asianet"],
  "Surya TV": ["surya tv malayalam", "surya tv"],
  "Flowers TV": ["flowers tv malayalam", "flowers tv"],
  "Mazhavil Manorama": ["mazhavil manorama", "manorama"],
  "Shemaroo TV": ["shemaroo tv marathi", "shemaroo tv"],
  "Saregama TV": ["saregama tv tamil", "saregama tv"],
  "Kalaignar TV": ["kalaignar tv tamil", "kalaignar tv"],
  "Udaya TV": ["udaya tv kannada", "udaya tv", "udaya"],
  "NXT": ["nxt"],
  "Dangal TV": ["dangal tv", "dangal"],
  "&TV": ["and tv", "&tv", "& tv"],
  "MTV": ["mtv"],
};

/**
 * Entries that are not TV channels: streaming platforms and the generic "Urdu TV". They are
 * listed in Discover's "Channel / Platform" filter without the Live TV check (they never are
 * in Live TV); real channels are listed only when Live TV has them.
 */
export const PLATFORMS: ReadonlySet<string> = new Set(["Zee5", "SonyLIV", "JioHotstar", "Voot", "Aha", "Sun NXT", "Urdu TV"]);

const ALIASES = Object.entries(CHANNELS)
  .flatMap(([canonical, aliases]) => aliases.map((a) => ({ alias: a, canonical })))
  .sort((a, b) => b.alias.length - a.alias.length); // longest first: "star vijay tamil" before "star vijay"

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// "<channel> : title" or "<channel> | title". The separator is required, so a title that merely
// starts with a channel's words ("Colors of Love", "Sunrise") is untouched; " - " is NOT one:
// that is how portals tag a film's language or year ("Dangal - Telugu", "Dangal - 2016",
// "Colors - Mal", "Gemini - (ES)" are films, and read as channels they lost their names).
const PREFIX_RE = new RegExp(`^\\s*(${ALIASES.map((a) => escape(a.alias).replace(/ /g, "\\s+")).join("|")})\\s*[:|]\\s*(.+)$`, "i");
const ONLY_YEAR_RE = /^[\s(\[]*(?:19|20)\d{2}[\s)\]]*$/;
// Looked up with the matched text's spaces collapsed ("Play Entertainment  Tv").
const CANONICAL = new Map(ALIASES.map((a) => [a.alias, a.canonical]));

export interface ChannelSplit {
  channel: string | null;
  title: string;
}

/** "Zee5 : Manemagalu" -> { channel: "Zee5", title: "Manemagalu" }; no channel -> title as given. */
export function splitChannel(name: string): ChannelSplit {
  const m = PREFIX_RE.exec(String(name || ""));
  if (!m || !m[2].trim() || ONLY_YEAR_RE.test(m[2])) return { channel: null, title: String(name || "") };
  return { channel: CANONICAL.get(m[1].toLowerCase().replace(/\s+/g, " ")) ?? m[1], title: m[2].trim() };
}

