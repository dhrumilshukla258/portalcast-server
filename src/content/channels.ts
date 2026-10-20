// TV channels named in catalog titles: "Zee5 : Manemagalu", "Udaya Tv : Madumagalu",
// "HUM TV : Mere Humsafar". Portals put the channel a show airs on in front of its name.
// splitChannel() separates the two, so Discover can show the clean title with the
// channel's logo beside it, TMDB is searched with the title alone, and the same show
// listed under two channels groups as one title.
//
// The list is curated, not "anything before a colon": that pattern also catches
// franchises ("Star Wars : ...", "Avatar : ...", "Batman : ...") and real titles
// ("Jack Carr Investigates: ..."). Aliases are the spellings seen on real portals.

import { splitChannel } from "@/content/channelNames";
import { fetchTvNetworks } from "@/content/tmdb";
import { xtreamCache } from "@/services/xtreamCache";
import { QueryTypes } from "sequelize";
import { sequelize } from "@/db";
import { channelLogoPath, proxiedImageUrl } from "@/providers/portalAssets";
import { logger } from "@/infra/logger";
import { CHANNELS } from "@/content/channelNames";

export { splitChannel, type ChannelSplit } from "@/content/channelNames";

// ---- logos, from the live channel list -----------------------------------------------
// "ZEE TELUGU HD", "STAR MAA 4K", "HUM TV 4K (hevc)", "ZEE TV CANADA HD" all reduce to
// the channel itself; the HD/4K India entry is preferred (best, most standard logo).
const NOISE_RE = /\b(4k|uhd|fhd|hd|sd|hevc|h265|india|usa|us|uk|canada|europe|eu|asia|middle east|me|africa|aus|australia|cc|backup|\+\d+)\b|[()*]/gi;
const LOGO_TTL_MS = 10 * 60 * 1000;
let logos: Map<string, string> | null = null;
let logosAt = 0;
let loading: Promise<void> | null = null;

function norm(s: string): string {
  return s.toLowerCase().replace(NOISE_RE, " ").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

async function loadLogos(): Promise<void> {
  const rows = await sequelize.query<{ name: string; logo: string | null }>(
    "SELECT name, logo FROM channels WHERE logo IS NOT NULL AND logo != ''",
    { type: QueryTypes.SELECT },
  );
  // normalized channel name -> [score, logo]; higher score wins
  const best = new Map<string, [number, string]>();
  for (const r of rows) {
    const key = norm(r.name);
    if (!key) continue;
    const upper = r.name.toUpperCase();
    const score = (/\bHD\b/.test(upper) ? 2 : 0) + (/\bINDIA\b/.test(upper) || !/\b(USA|UK|CANADA|EUROPE)\b/.test(upper) ? 1 : 0);
    const cur = best.get(key);
    if (!cur || score > cur[0]) best.set(key, [score, r.logo!]);
  }
  const map = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(CHANNELS)) {
    for (const candidate of [canonical, ...aliases]) {
      const hit = best.get(norm(candidate));
      if (hit) { map.set(canonical, hit[1]); break; }
    }
  }
  logos = map;
  logosAt = Date.now();
  // The TMDB cache is read alongside (cheap); filling it runs separately (server.ts).
  tmdbLogos = (await xtreamCache.get<TmdbLogoCache>(TMDB_LOGO_KEY)) || tmdbLogos;
  logger.info(`[channels] logos for ${map.size}/${Object.keys(CHANNELS).length} catalog channels`);
}

// ---- TMDB network logos ----------------------------------------------------------------
// For each channel, a few of its shows that TMDB matched are looked up once; the network
// whose name is the channel's gives the logo (TMDB's are clean, transparent PNGs). Kept in
// xtreamCache; channels with no answer are retried after a week.
const TMDB_LOGO_KEY = "channel_logos_tmdb";
const TMDB_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
type TmdbLogoCache = Record<string, { logo: string | null; at: number }>;
let tmdbLogos: TmdbLogoCache = {};
let tmdbRunning = false;

function sameChannel(network: string, channel: string): boolean {
  const n = norm(network);
  if (!n) return false;
  return [channel, ...(CHANNELS[channel] || [])].some((alias) => {
    const a = norm(alias);
    return a === n || (a.length >= 4 && (n.startsWith(`${a} `) || a.startsWith(`${n} `)));
  });
}

export async function resolveTmdbChannelLogos(): Promise<void> {
  if (tmdbRunning) return;
  tmdbRunning = true;
  try {
    tmdbLogos = (await xtreamCache.get<TmdbLogoCache>(TMDB_LOGO_KEY)) || {};
    const due = Object.keys(CHANNELS).filter((c) => {
      const e = tmdbLogos[c];
      return !e || (!e.logo && Date.now() - e.at > TMDB_RETRY_MS);
    });
    if (due.length === 0) return;
    const rows = await sequelize.query<{ name: string; tmdbId: number }>(
      "SELECT name, tmdbId FROM content_meta WHERE type = 'series' AND tmdbId IS NOT NULL AND (instr(name, ':') > 0 OR instr(name, '|') > 0 OR instr(name, ' - ') > 0)",
      { type: QueryTypes.SELECT },
    );
    const showsOf = new Map<string, number[]>();
    for (const r of rows) {
      const c = splitChannel(r.name).channel;
      if (!c || !due.includes(c)) continue;
      const list = showsOf.get(c) || [];
      if (list.length < 3 && !list.includes(Number(r.tmdbId))) list.push(Number(r.tmdbId));
      showsOf.set(c, list);
    }
    let found = 0;
    for (const channel of due) {
      let logo: string | null = null;
      for (const id of showsOf.get(channel) || []) {
        const networks = await fetchTvNetworks(id);
        const hit = networks?.find((n) => n.logo && sameChannel(n.name, channel));
        if (hit) { logo = hit.logo; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      tmdbLogos[channel] = { logo, at: Date.now() };
      if (logo) found++;
    }
    await xtreamCache.set(TMDB_LOGO_KEY, tmdbLogos);
    logger.info(`[channels] TMDB network logos: ${found} found for ${due.length} channels looked up`);
  } catch (e: any) {
    logger.warn(`[channels] TMDB network logos failed: ${e?.message ?? e}`);
  } finally {
    tmdbRunning = false;
  }
}

/** Warm (or refresh) the logo map without waiting for it. */
export function refreshChannelLogos(): void {
  if (loading) return;
  loading = loadLogos()
    .catch((e) => logger.warn(`[channels] logo load failed: ${e?.message ?? e}`))
    .finally(() => { loading = null; });
}

/**
 * The channel's logo as a client image path: a portal-root path (clients load it through
 * the server's /api/images relay, like every portal image) or a signed proxy URL for an
 * absolute logo, so the portal's address never reaches a client. Null when unknown.
 * Synchronous: answers from the cached map and refreshes it in the background.
 */
export function channelLogo(channel: string | null | undefined, origin?: string): string | null {
  if (!channel) return null;
  const tmdb = tmdbLogos[channel]?.logo;
  if (tmdb) return tmdb; // image.tmdb.org: clients load it directly
  if (!logos || Date.now() - logosAt > LOGO_TTL_MS) refreshChannelLogos();
  const raw = logos?.get(channel);
  if (!raw) return null;
  const path = channelLogoPath(raw);
  return path.startsWith("http") ? proxiedImageUrl(path, origin) : path;
}
