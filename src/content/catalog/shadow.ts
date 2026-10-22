// Shadow comparison (plan, Phase 1b rollout): while the catalog snapshot answers Discover's
// title data, 1 request in 20 is also answered the old way (the database), in the background,
// and any difference is counted and logged. Bounded so it never adds load at busy times: one
// check at a time, at most one a second. A check during which the database changed is not
// counted either way (the two reads would not be of the same moment).
//
// Not for the "All" lists: their old answer needs the parsed union of every list (~186 MB),
// which is what the snapshot removes; they were checked off vs on before the switch instead.

import { logger } from "@/infra/logger";
import { catalogChanges } from "./store";

const SAMPLE_EVERY = 20;
const MIN_GAP_MS = 1000;
const LOG_GAP_MS = 60_000;

let seen = 0;
let busy = false;
let lastAt = 0;
let lastLogAt = 0;
const stats = { checked: 0, differed: 0, skipped: 0, lastDifference: null as null | { at: string; what: string; detail: string } };

export function shadowStatus() {
  return { ...stats };
}

/**
 * Maybe compares `snapshotAnswer` (already computed, as text) with what `databaseAnswer`
 * gives now. Returns at once; the database read runs after the current request.
 */
export function shadowCheck(what: string, snapshotAnswer: string, databaseAnswer: () => Promise<string>): void {
  if (++seen % SAMPLE_EVERY !== 0 || busy || Date.now() - lastAt < MIN_GAP_MS) return;
  busy = true;
  lastAt = Date.now();
  setImmediate(async () => {
    try {
      const before = (await catalogChanges())?.seq;
      const old = await databaseAnswer();
      const after = (await catalogChanges())?.seq;
      if (before !== after) { stats.skipped++; return; }
      stats.checked++;
      if (old === snapshotAnswer) return;
      stats.differed++;
      let p = 0;
      while (p < old.length && old[p] === snapshotAnswer[p]) p++;
      const detail = `database ${old.slice(Math.max(0, p - 60), p + 60)} | snapshot ${snapshotAnswer.slice(Math.max(0, p - 60), p + 60)}`;
      stats.lastDifference = { at: new Date().toISOString(), what, detail };
      if (Date.now() - lastLogAt > LOG_GAP_MS) {
        lastLogAt = Date.now();
        logger.warn(`[catalog] shadow check: ${what} differs from the database (${stats.differed} of ${stats.checked} so far): ${detail}`);
      }
    } catch (e: any) {
      stats.skipped++;
      logger.warn(`[catalog] shadow check failed (${what}): ${e?.message ?? e}`);
    } finally {
      busy = false;
    }
  });
}
