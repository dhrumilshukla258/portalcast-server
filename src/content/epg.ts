import { setting } from "@/config/settings";
import {
  readChannels,
  readGenres,
  readEpgCache,
  writeEpgCache,
} from "../infra/storage";
import { serverManager } from "@/serverManager";
import { Channel, EPG_List, Genre } from "@/types/domain";
import { initialConfig } from "@/config/server";
import { ConfigProfile } from "@/models/ConfigProfile";
import { logger } from "@/infra/logger";
import { primeEpgSnapshot, getEpgSnapshot, programmesOf } from "@/content/epgServe";
import { inBackground } from "@/services/portalPace";
import { SystemConfig } from "@/models/SystemConfig";

const CACHE_DURATION_MS = 12 * 60 * 60 * 1000;
// Pause between 5-channel batches of the EPG fetch, to stay gentle on the portal. Overridable
// for the benchmark harness (scripts/bench), where 10k channels x 500 ms would take ~17 min.
const BATCH_DELAY_MS = () => setting<number>("epgBatchDelayMs");

interface EpgCache {
  timestamp: Date;
  data: Record<string, EPG_List[]>;
}

/**
 * Reads the EPG cache from database for the active profile.
 * Returns null if the cache is stale or does not exist.
 */
export async function getEpgCache(): Promise<EpgCache | null> {
  try {
    const activeProfile = await ConfigProfile.findOne({
      where: { isActive: true },
    });
    const profileId = activeProfile?.id;

    const cache = await readEpgCache(profileId);
    if (!cache) {
      return null;
    }

    const isStale =
      Date.now() - new Date(cache.timestamp).getTime() > CACHE_DURATION_MS;
    if (isStale) {
      return null;
    }
    return cache;
  } catch (error) {
    logger.warn(`Could not read EPG cache: ${error}`);
    return null;
  }
}

/**
 * Fetches EPG for all filtered channels and writes to cache for the active profile.
 * Its portal requests go through the background queue (services/portalPace.ts): one at a time,
 * paced, waiting out "too many requests" — on a big portal the first guide takes hours.
 * Channels known to have no guide are asked again only every epgEmptyRecheckHours (below);
 * `full` (Admin's "Refresh guide") asks every channel.
 */
export function fetchAndCacheEpg(options: { full?: boolean } = {}): Promise<EpgCache> {
  return inBackground(() => fetchAndCacheEpgNow(options));
}

// Channels without a guide (owner, 2026-10-23: 8,138 of 10,171 channels on one portal, asked at
// every 12-hourly refresh for nothing). Per profile: channel id -> [empty answers in a row, when
// last asked (ms)]. Only real answers count; a refused or failed request changes nothing.
const EMPTY_KEY = (profileId: number | undefined) => `epg_empty_${profileId ?? "none"}`;
const EMPTY_IN_A_ROW = 2;
type EmptyState = Record<string, [number, number]>;

async function readEmpty(profileId: number | undefined): Promise<EmptyState> {
  const row = await SystemConfig.findByPk(EMPTY_KEY(profileId)).catch(() => null);
  return row?.value && typeof row.value === "object" ? { ...row.value } : {};
}

/** Not asked this time: no guide at the last [EMPTY_IN_A_ROW] answers, asked less than [recheckMs] ago. */
export function skipEmpty(state: EmptyState, id: string, recheckMs: number, now = Date.now()): boolean {
  const e = state[id];
  return recheckMs > 0 && !!e && e[0] >= EMPTY_IN_A_ROW && now - e[1] < recheckMs;
}

async function fetchAndCacheEpgNow(options: { full?: boolean } = {}): Promise<EpgCache> {
  logger.info("Fetching fresh EPG data...");

  const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
  const profileId = activeProfile?.id;

  const [channels, genres] = await Promise.all([
    readChannels(profileId),
    readGenres("channel", profileId)
  ]);

  // FIX 1: Use a Map for O(1) lookup instead of .find() inside .filter()
  const filteredChannels = initialConfig.groups.length === 0
    ? channels
    : (() => {
        const genreMap = new Map(genres.map(g => [g.id, g.title]));
        const groupSet = new Set(initialConfig.groups);
        return channels.filter((channel) => {
          const genreTitle = genreMap.get(channel.tv_genre_id);
          return genreTitle && groupSet.has(genreTitle);
        });
      })();

  const CONCURRENCY_LIMIT = 5; // Reduced slightly to give CPU breathing room
  const epgData: Record<string, EPG_List[]> = {}; // Directly push to final object

  // Channels without a guide at the last refreshes keep their empty list without being asked.
  const recheckMs = Math.max(0, Number(setting<number>("epgEmptyRecheckHours")) || 0) * 3600_000;
  const empty = await readEmpty(profileId);
  const fetchNow = Date.now();
  const toFetch: Channel[] = [];
  for (const channel of filteredChannels) {
    if (!options.full && skipEmpty(empty, String(channel.id), recheckMs, fetchNow)) epgData[channel.id] = [];
    else toFetch.push(channel);
  }
  const skipped = filteredChannels.length - toFetch.length;

  logger.info(`Starting EPG fetch for ${toFetch.length} channels${skipped ? ` (${skipped} without a guide not asked this time; asked again every ${recheckMs / 3600_000} h)` : ""}...`);

  // Channels the portal refused (a 429 that outlasted the retries, a failed sign-in) are asked
  // once more after the rest; any still refused keep the programmes they had.
  const refused: string[] = [];
  const startedAt = Date.now();
  // A real answer: empty extends the channel's run of empty answers, a guide clears it.
  const noteAnswer = (id: string, programmes: unknown[]) => {
    if (programmes.length) delete empty[id];
    else empty[id] = [(empty[id]?.[0] ?? 0) + 1, Date.now()];
  };

  for (let i = 0; i < toFetch.length; i += CONCURRENCY_LIMIT) {
    const chunk = toFetch.slice(i, i + CONCURRENCY_LIMIT);

    const chunkResults = await Promise.all(
      chunk.map(async (channel) => {
        try {
          const epg = await serverManager.getProvider().getEPG(channel.id);
          noteAnswer(String(channel.id), epg.js || []);
          return { id: channel.id, epg: epg.js || [] };
        } catch (error) {
          refused.push(channel.id);
          logger.error(`EPG fetch error for channel ${channel.id}: ${error}`);
          return { id: channel.id, epg: [] as EPG_List[] };
        }
      })
    );

    // FIX 2: Merge results into epgData immediately
    for (const res of chunkResults) {
      epgData[res.id] = res.epg;
    }

    // FIX 3: THE MAGIC STICK - Yield control back to Event Loop
    await new Promise(resolve => setImmediate(resolve));

    const done = Math.min(i + CONCURRENCY_LIMIT, toFetch.length);
    if (done % 500 < CONCURRENCY_LIMIT && done < toFetch.length) {
      logger.info(`EPG fetch: ${done}/${toFetch.length} channels (${Math.round((Date.now() - startedAt) / 60000)} min)`);
    }
    
    if (BATCH_DELAY_MS() > 0 && !serverManager.getProvider().localGuide && i + CONCURRENCY_LIMIT < toFetch.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS()));
    }
  }

  let kept = 0;
  if (refused.length > 0) {
    logger.info(`EPG fetch: asking again for ${refused.length} channels the portal refused`);
    // The served guide holds each channel's running and upcoming programmes in compact columns;
    // reading one channel back costs only its own programmes.
    const served = await getEpgSnapshot().catch(() => null);
    for (const id of refused) {
      try {
        epgData[id] = (await serverManager.getProvider().getEPG(id)).js || [];
        noteAnswer(String(id), epgData[id]);
      } catch (error) {
        epgData[id] = served ? programmesOf(served, id) : [];
        kept++;
        logger.warn(`EPG fetch: channel ${id} refused again, keeping its previous programmes: ${error}`);
      }
    }
  }

  const cache: EpgCache = { timestamp: new Date(), data: epgData };
  await writeEpgCache(cache, profileId);
  // Channels no longer listed are forgotten.
  const listed = new Set(filteredChannels.map((c) => String(c.id)));
  for (const id of Object.keys(empty)) if (!listed.has(id)) delete empty[id];
  await SystemConfig.upsert({ key: EMPTY_KEY(profileId), value: empty }).catch((e) => logger.warn(`EPG: could not keep the channels without a guide: ${e?.message ?? e}`));

  logger.info(`EPG cache updated: ${filteredChannels.length} channels${skipped ? ` (${skipped} without a guide not asked)` : ""} in ${Math.round((Date.now() - startedAt) / 60000)} min${refused.length ? `; ${refused.length - kept} refused at first and fetched again, ${kept} kept their previous programmes` : ""}.`);
  // Rebuild the served snapshot (full-guide gzip + programme windows) now, not on the first
  // client request after the refresh.
  primeEpgSnapshot();
  return cache;
}