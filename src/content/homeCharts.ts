// What is popular out there, per country (owner, 2026-10-22: "what's trending in the market,
// USA, India, any, based on the viewer's profile"), limited to titles this server has:
//
//   netflix   "On Netflix's Top 10 in India": Netflix's official weekly Top 10 per country
//             (top10.netflix.com data files, no key), the latest two weeks, matched by name
//   cinema    "In cinemas in India": TMDB's now playing for the country
//   provider  "Popular on Prime Video in India": the country's most prominent streaming
//             services (TMDB's JustWatch data, read per country, not a fixed list)
//   onair     "New episodes this week": TMDB's series with an episode in the next 7 days
//
// A viewer's countries come from what they watch (content/home.ts: Hindi or Tamil -> India,
// Korean -> South Korea, English -> the server's chartCountry setting); a mix gives two. Lists
// are fetched in the background and cached (Netflix daily, TMDB every 12 h); a Home build never
// waits for a fetch that is not ready, it uses what it has.

import axios from "axios";
import readline from "readline";
import { setting } from "@/config/settings";
import { logger } from "@/infra/logger";
import { fetchNowPlayingIds, fetchOnTheAirIds, fetchRegionProviders, fetchPopularOnProviderIds } from "@/content/tmdb";

const NETFLIX_COUNTRIES_URL = "https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv";
const NETFLIX_TTL = 24 * 3600_000;
const TMDB_TTL = 12 * 3600_000;
const PROVIDERS_PER_COUNTRY = 3;

/** One chart: TMDB ids or titles by name, best first. */
export interface ChartList {
  key: string;
  title: string;
  tmdb?: { kind: "movie" | "series"; id: number }[];
  names?: { kind: "movie" | "series"; name: string }[];
}

// ── which countries ─────────────────────────────────────────────────────────────────

/** Languages spoken mostly in one country. English and Spanish are not here (many countries). */
const LANGUAGE_COUNTRY: Record<string, string> = {
  hi: "IN", ta: "IN", te: "IN", ml: "IN", kn: "IN", mr: "IN", bn: "IN", pa: "IN", gu: "IN", or: "IN", as: "IN",
  ko: "KR", ja: "JP", fr: "FR", de: "DE", it: "IT", pt: "BR", tr: "TR", pl: "PL", nl: "NL", sv: "SE",
  da: "DK", no: "NO", fi: "FI", th: "TH", id: "ID", tl: "PH", vi: "VN", zh: "TW", cn: "HK", ur: "PK", he: "IL",
  el: "GR", cs: "CZ", hu: "HU", ro: "RO", uk: "UA", ru: "RU", fa: "IR", ar: "EG", ms: "MY",
};

/**
 * The viewer's chart countries from the languages they watch (weights): each language votes
 * for its country (others for the server's default); the top one, and a second one when it has
 * at least a quarter of the weight (a viewer of English and Hindi gets the US and India).
 */
export function viewerCountries(langWeights: { code: string; weight: number }[]): string[] {
  const fallback = String(setting<string>("chartCountry") || "US").toUpperCase();
  const votes = new Map<string, number>();
  let total = 0;
  for (const { code, weight } of langWeights) {
    const c = LANGUAGE_COUNTRY[code.toLowerCase()] ?? fallback;
    votes.set(c, (votes.get(c) ?? 0) + weight);
    total += weight;
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return [fallback];
  const out = [ranked[0][0]];
  if (ranked[1] && ranked[1][1] >= total * 0.25) out.push(ranked[1][0]);
  return out;
}

let regionNames: Intl.DisplayNames | null = null;
function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    const name = regionNames.of(code) ?? code;
    // "the US", "the UK": reads better in "Top 10 in …".
    return ["US", "GB", "AE", "NL", "PH"].includes(code) ? `the ${code === "US" ? "US" : code === "GB" ? "UK" : name}` : name;
  } catch {
    return code;
  }
}

// ── Netflix Top 10 ───────────────────────────────────────────────────────────────────

type NetflixWeek = Map<string, { kind: "movie" | "series"; name: string }[]>; // country -> titles
let netflix: { at: number; value: NetflixWeek | null; loading: Promise<void> | null } = { at: 0, value: null, loading: null };

/** Streams the file (32 MB, every week since 2021) and keeps the latest two weeks per country. */
export async function loadNetflix(): Promise<NetflixWeek | null> {
  const res = await axios.get(NETFLIX_COUNTRIES_URL, { responseType: "stream", timeout: 60_000 });
  const lines = readline.createInterface({ input: res.data, crlfDelay: Infinity });
  const weeks = new Map<string, string[]>(); // country -> its weeks seen, newest first (file order)
  const out: NetflixWeek = new Map();
  let header: string[] | null = null;
  for await (const line of lines) {
    const cols = line.split("\t");
    if (!header) { header = cols; continue; }
    const at = (name: string) => cols[header!.indexOf(name)] ?? "";
    const country = at("country_iso2").toUpperCase();
    const week = at("week");
    if (!country || !week) continue;
    let seen = weeks.get(country);
    if (!seen) weeks.set(country, (seen = []));
    if (!seen.includes(week)) {
      if (seen.length >= 2) continue; // older than the latest two weeks
      seen.push(week);
    }
    const kind = at("category").toLowerCase().startsWith("tv") ? "series" : "movie";
    const list = out.get(country) ?? [];
    list.push({ kind, name: at("show_title") });
    out.set(country, list);
  }
  return out.size ? out : null;
}

function netflixWeek(): NetflixWeek | null {
  if (Date.now() - netflix.at >= NETFLIX_TTL && !netflix.loading) {
    netflix.loading = loadNetflix()
      .then((v) => { if (v) netflix.value = v; logger.debug(`[home] Netflix Top 10: ${v?.size ?? 0} countries`); })
      .catch((e) => logger.warn(`[home] Netflix Top 10 not fetched: ${e?.message ?? e}`))
      .finally(() => { netflix.at = Date.now(); netflix.loading = null; });
  }
  return netflix.value;
}

// ── TMDB lists ───────────────────────────────────────────────────────────────────────

interface TmdbLists { at: number; lists: ChartList[] | null; loading: Promise<void> | null }
const tmdbByCountry = new Map<string, TmdbLists>();
let onAir: { at: number; list: ChartList | null; loading: Promise<void> | null } = { at: 0, list: null, loading: null };

async function loadCountryLists(country: string): Promise<ChartList[]> {
  const where = countryName(country);
  const lists: ChartList[] = [];
  const cinema = await fetchNowPlayingIds(country);
  if (cinema?.length) lists.push({ key: `cinema:${country}`, title: `In cinemas in ${where}`, tmdb: cinema.map((id) => ({ kind: "movie" as const, id })) });
  const providers = (await fetchRegionProviders(country)) ?? [];
  for (const p of providers.slice(0, PROVIDERS_PER_COUNTRY)) {
    const [movies, tv] = await Promise.all([fetchPopularOnProviderIds("movie", country, p.id), fetchPopularOnProviderIds("tv", country, p.id)]);
    const tmdb: ChartList["tmdb"] = [];
    for (let i = 0; i < Math.max(movies?.length ?? 0, tv?.length ?? 0); i++) {
      if (movies?.[i] !== undefined) tmdb.push({ kind: "movie", id: movies[i] });
      if (tv?.[i] !== undefined) tmdb.push({ kind: "series", id: tv[i] });
    }
    if (tmdb.length) lists.push({ key: `provider:${p.id}:${country}`, title: `Popular on ${p.name} in ${where}`, tmdb });
  }
  return lists;
}

function countryLists(country: string): ChartList[] {
  let e = tmdbByCountry.get(country);
  if (!e) tmdbByCountry.set(country, (e = { at: 0, lists: null, loading: null }));
  const entry = e;
  if (Date.now() - entry.at >= TMDB_TTL && !entry.loading) {
    entry.loading = loadCountryLists(country)
      .then((lists) => { if (lists.length) entry.lists = lists; })
      .catch((err) => logger.warn(`[home] TMDB lists for ${country} not fetched: ${err?.message ?? err}`))
      .finally(() => { entry.at = Date.now(); entry.loading = null; });
  }
  return entry.lists ?? [];
}

function onAirList(): ChartList | null {
  if (Date.now() - onAir.at >= TMDB_TTL && !onAir.loading) {
    onAir.loading = fetchOnTheAirIds()
      .then((ids) => { if (ids?.length) onAir.list = { key: "onair", title: "New episodes this week", tmdb: ids.map((id) => ({ kind: "series" as const, id })) }; })
      .catch(() => {})
      .finally(() => { onAir.at = Date.now(); onAir.loading = null; });
  }
  return onAir.list;
}

/**
 * The charts for these countries that are ready now (fetches start in the background on first
 * ask and refresh themselves; nothing here waits on the network).
 */
export function chartsFor(countries: string[]): ChartList[] {
  const out: ChartList[] = [];
  const nf = netflixWeek();
  for (const c of countries) {
    const titles = nf?.get(c);
    if (titles?.length) out.push({ key: `netflix:${c}`, title: `On Netflix's Top 10 in ${countryName(c)}`, names: titles });
    out.push(...countryLists(c));
  }
  const air = onAirList();
  if (air) out.push(air);
  return out;
}

/** Changes whenever a list arrives, so Home rows built before it are rebuilt. */
export function chartsStamp(): string {
  return `${netflix.value ? netflix.at : 0}.${[...tmdbByCountry.values()].map((e) => (e.lists ? e.at : 0)).join(".")}.${onAir.list ? onAir.at : 0}`;
}
