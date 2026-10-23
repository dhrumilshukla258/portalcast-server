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
 */
export function fetchAndCacheEpg(): Promise<EpgCache> {
  return inBackground(fetchAndCacheEpgNow);
}

async function fetchAndCacheEpgNow(): Promise<EpgCache> {
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

  logger.info(`Starting EPG fetch for ${filteredChannels.length} channels...`);

  // Channels the portal refused (a 429 that outlasted the retries, a failed sign-in) are asked
  // once more after the rest; any still refused keep the programmes they had.
  const refused: string[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < filteredChannels.length; i += CONCURRENCY_LIMIT) {
    const chunk = filteredChannels.slice(i, i + CONCURRENCY_LIMIT);

    const chunkResults = await Promise.all(
      chunk.map(async (channel) => {
        try {
          const epg = await serverManager.getProvider().getEPG(channel.id);
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

    const done = Math.min(i + CONCURRENCY_LIMIT, filteredChannels.length);
    if (done % 500 < CONCURRENCY_LIMIT && done < filteredChannels.length) {
      logger.info(`EPG fetch: ${done}/${filteredChannels.length} channels (${Math.round((Date.now() - startedAt) / 60000)} min)`);
    }
    
    if (BATCH_DELAY_MS() > 0 && i + CONCURRENCY_LIMIT < filteredChannels.length) {
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
      } catch (error) {
        epgData[id] = served ? programmesOf(served, id) : [];
        kept++;
        logger.warn(`EPG fetch: channel ${id} refused again, keeping its previous programmes: ${error}`);
      }
    }
  }

  const cache: EpgCache = { timestamp: new Date(), data: epgData };
  await writeEpgCache(cache, profileId);

  logger.info(`EPG cache updated: ${filteredChannels.length} channels in ${Math.round((Date.now() - startedAt) / 60000)} min${refused.length ? `; ${refused.length - kept} refused at first and fetched again, ${kept} kept their previous programmes` : ""}.`);
  // Rebuild the served snapshot (full-guide gzip + programme windows) now, not on the first
  // client request after the refresh.
  primeEpgSnapshot();
  return cache;
}