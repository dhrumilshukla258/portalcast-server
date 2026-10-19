// Which subtitle API keys to use for a request: the signed-in user's own keys when they
// set them (Settings > Subtitle accounts), else the server's (env). Users' keys are stored
// encrypted (auth/crypto.ts) and never sent back to clients.

import { User } from "@/models/User";
import { decryptSecret } from "@/auth/crypto";
import { openSubtitlesApiKey, subdlApiKey } from "@/config/server";
import { logger } from "@/infra/logger";

export interface SubtitleKeys {
  openSubtitles: string;
  subdl: string;
}

const cache = new Map<number, { at: number; keys: { openSubtitles?: string; subdl?: string } }>();
const TTL_MS = 5 * 60 * 1000;

function dec(v: string | null | undefined, what: string, userId: number): string | undefined {
  if (!v) return undefined;
  try { return decryptSecret(v); } catch (e) {
    logger.error(`[subtitles] could not decrypt ${what} for user ${userId}: ${e}`);
    return undefined;
  }
}

export async function subtitleKeysFor(userId?: number): Promise<SubtitleKeys> {
  let own: { openSubtitles?: string; subdl?: string } = {};
  if (userId !== undefined) {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < TTL_MS) own = hit.keys;
    else {
      const u = await User.findByPk(userId, { attributes: ["id", "openSubtitlesApiKeyEnc", "subdlApiKeyEnc"] });
      own = {
        openSubtitles: dec(u?.openSubtitlesApiKeyEnc, "OpenSubtitles key", userId),
        subdl: dec(u?.subdlApiKeyEnc, "SubDL key", userId),
      };
      cache.set(userId, { at: Date.now(), keys: own });
    }
  }
  return { openSubtitles: own.openSubtitles || openSubtitlesApiKey, subdl: own.subdl || subdlApiKey };
}

export function forgetSubtitleKeys(userId: number): void {
  cache.delete(userId);
}
