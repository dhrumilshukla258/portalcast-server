// Which id range each profile's portal ids use (providers/profileIds.ts). Kept in system_config
// as { profileId: slot }. The first profile to be active takes slot 0, the portal's own ids, so
// the data a server has today stays with the profile that made it; each other profile takes the
// next slot the first time it is active. Slots are never given again, so data left by a deleted
// profile can never be read as another's.
import { SystemConfig } from "@/models/SystemConfig";
import { Channel } from "@/models/Channel";
import { Genre } from "@/models/Genre";
import { EpgCache } from "@/models/EpgCache";
import { ContentCache } from "@/models/ContentCache";
import { MAX_SLOT } from "@/providers/profileIds";
import { logger } from "@/infra/logger";

const KEY = "profile_id_slots";
let active = 0;

/** The active profile's slot (0 before a profile is loaded). */
export function activeSlot(): number {
  return active;
}

export function setActiveSlot(slot: number): void {
  active = slot;
}

/** A stored value about the portal itself (not keyed by its ids), per profile: as it is in slot 0. */
export function profileKey(key: string, slot = active): string {
  return slot ? `${key}@${slot}` : key;
}

async function readSlots(): Promise<Record<string, number>> {
  const row = await SystemConfig.findByPk(KEY);
  return row?.value && typeof row.value === "object" && !Array.isArray(row.value) ? { ...row.value } : {};
}

/**
 * The profile's slot, given now if it has none. A profile that takes a slot other than 0 had its
 * channels, categories and guide stored with the portal's own ids: they are dropped and fetched
 * again (as an edited profile's are), so they are not read as the first profile's.
 */
export async function slotFor(profileId: number): Promise<number> {
  const slots = await readSlots();
  const known = slots[String(profileId)];
  if (Number.isInteger(known)) return known;
  const used = Object.values(slots).filter((s) => Number.isInteger(s));
  const slot = used.length ? Math.max(...used) + 1 : 0;
  if (slot > MAX_SLOT) {
    throw new Error(`This server has given out all ${MAX_SLOT + 1} profile id ranges; edit an existing profile instead of adding one.`);
  }
  if (slot > 0) {
    await Channel.destroy({ where: { profileId } });
    await Genre.destroy({ where: { profileId } });
    await EpgCache.destroy({ where: { profileId } });
    await ContentCache.destroy({ where: { profileId } });
    await SystemConfig.destroy({ where: { key: `epg_empty_${profileId}` } });
  }
  slots[String(profileId)] = slot;
  await SystemConfig.upsert({ key: KEY, value: slots });
  logger.info(`[profiles] profile ${profileId} uses id range ${slot}${slot ? " (its channels, categories and guide are fetched again)" : ""}`);
  return slot;
}
